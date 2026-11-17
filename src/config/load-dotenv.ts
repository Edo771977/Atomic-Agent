import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describeMalformedApiKey, isSecretVariableName, STRICT_CLOUD_KEY_VARS } from "./api-key-shape.js";
import {
  loadKeychainSecrets,
  type KeychainLoadResult,
  type SecretKeychain,
} from "./secret-store.js";

/**
 * A `.env` read failure that survived the retry loop (or was not
 * retryable). Deliberately tiny: the errno code plus the attempt count.
 * The path lives on `DotenvLoadResult.path`, and for errno failures
 * Node's message is a fixed function of code, syscall, and path, so
 * carrying it here would add no diagnostics.
 */
export interface DotenvReadFailure {
  /** Node errno code (`"EPERM"`, `"EACCES"`, ...) or null when absent. */
  code: string | null;
  /** How many read attempts were made before giving up. */
  attempts: number;
}

export interface DotenvLoadResult {
  /** Absolute path of the `.env` file we attempted to read. */
  path: string;
  /**
   * Whether the file was found and parsed. Stays `false` both when the
   * file is missing and when it exists but could not be read; `error`
   * distinguishes the two.
   */
  exists: boolean;
  /** Names of variables that were applied to `process.env`. Never values. */
  loaded: string[];
  /** Names of variables present in the file but already set in `process.env`. */
  skipped: string[];
  /**
   * Names of secret variables (`*_API_KEY`, `*_TOKEN`, `*_SECRET`) whose
   * shell value was malformed (a placeholder such as `...`, whitespace
   * inside, a cloud key far too short) and was replaced by the file's
   * well-formed value. Never values.
   */
  replacedPlaceholders: string[];
  /**
   * Non-ENOENT read failure after retries. `null` when the file loaded
   * fine or does not exist. Frontends must surface this to the user:
   * a `.env` that exists but cannot be read means stored secrets were
   * silently dropped (#59).
   */
  error: DotenvReadFailure | null;
  /**
   * Keychain outcome when the operator opted into the OS keychain
   * (ATO-474); absent in the default `.env` mode. Its `loaded` names
   * are also in `loaded` above. Names only, never values.
   */
  keychain?: KeychainLoadResult;
}

/** I/O seams, injectable for tests. Production callers omit them. */
export interface DotenvIoDeps {
  readFile: (path: string) => string;
  sleep: (ms: number) => void;
}

/**
 * Codes worth retrying. On Windows, antivirus and sync software
 * (OneDrive, Dropbox) hold short-lived locks that surface as
 * EPERM/EACCES/EBUSY/EAGAIN. EACCES earns its slot only through that
 * Windows family: on POSIX it is almost always a permanent permission
 * denial, and retrying it there costs one ~200ms backoff loop before
 * the loud warning. ENOENT is never retried (missing file is the
 * silent no-op case) and everything else fails fast.
 */
const RETRYABLE_READ_CODES = new Set(["EPERM", "EACCES", "EBUSY", "EAGAIN"]);
const READ_ATTEMPTS = 3;
const READ_BACKOFF_MS: readonly number[] = [50, 150];

/**
 * Match a conventional env-var key: starts with an uppercase letter or an
 * underscore, followed by uppercase letters / digits / underscores. Lowercase
 * names and dashes are intentionally rejected — the loader only handles
 * canonical secrets, not arbitrary shell aliases.
 */
const KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Decode `.env` bytes by their byte-order mark. Windows PowerShell 5.1's
 * `>` and `Out-File` write UTF-16LE with a BOM (FF FE), and some editors
 * write UTF-16BE (FE FF) or UTF-8 with a BOM (EF BB BF); read as plain
 * UTF-8 those files parse to nothing, so their keys were silently
 * ignored. Without a BOM, bytes whose NULs all fall on one parity —
 * every odd byte NUL for UTF-16LE, every even one for UTF-16BE, as
 * ASCII text in UTF-16 reads — are that UTF-16 (`bomlessUtf16`);
 * anything else is UTF-8.
 */
export function decodeDotenvBytes(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2).toString("utf16le");
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2));
    swapBytes(swapped);
    return swapped.toString("utf16le");
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3).toString("utf8");
  }
  const bomless = bomlessUtf16(bytes);
  if (bomless === "le") return bytes.toString("utf16le");
  if (bomless === "be") {
    const swapped = Buffer.from(bytes);
    swapBytes(swapped);
    return swapped.toString("utf16le");
  }
  return bytes.toString("utf8");
}

/**
 * A BOM-less UTF-16 file of mostly ASCII text: an even length, and at
 * least half its code units carrying a NUL high byte with every NUL on
 * that side. A UTF-8 file with a stray NUL is not mistaken for one.
 */
function bomlessUtf16(bytes: Buffer): "le" | "be" | null {
  if (bytes.length < 2 || bytes.length % 2 !== 0) return null;
  let evenNul = 0;
  let oddNul = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] !== 0) continue;
    if (i % 2 === 0) evenNul += 1;
    else oddNul += 1;
  }
  const units = bytes.length / 2;
  if (oddNul >= units / 2 && evenNul === 0) return "le";
  if (evenNul >= units / 2 && oddNul === 0) return "be";
  return null;
}

/** Swap each byte pair in place; a trailing odd byte (a truncated file) stays. */
function swapBytes(buf: Buffer): void {
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const a = buf[i]!;
    buf[i] = buf[i + 1]!;
    buf[i + 1] = a;
  }
}

/** Blocking sleep for the synchronous config bootstrap path. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Strip a single matching pair of surrounding quotes (`"..."` or `'...'`).
 * Inner content is taken verbatim: no escape sequences (a backslash is
 * always literal, so a hand-written `"\\server\share"` keeps both
 * leading backslashes, as npm dotenv does), no `${VAR}` interpolation.
 * Only the first and last characters are inspected, so inner quotes of
 * either kind are literal as well; `setDotenvKey` relies on that rather
 * than writing escapes. Mismatched quotes are left as-is so the user
 * sees their literal value (and can debug from it).
 */
export function stripDotenvQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Parse a single line into `[key, value]` or `null` when the line is a
 * comment / blank / malformed. Unknown formats are reported via `onError`
 * so the caller can warn once and keep going. The diagnostic never echoes
 * the line itself: a line without `=` can be a fragment of a secret value
 * left behind by an external non-atomic writer, so only the 1-based line
 * number and length are reported.
 */
export function parseDotenvLine(
  line: string,
  lineNo: number,
  onError: (reason: string) => void = () => {},
): [string, string] | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith("#")) return null;

  const eq = trimmed.indexOf("=");
  if (eq === -1) {
    onError(`missing '=' on line ${lineNo} (${trimmed.length} chars)`);
    return null;
  }

  const key = trimmed.slice(0, eq).trim();
  const rawValue = trimmed.slice(eq + 1).trim();

  if (!KEY_PATTERN.test(key)) {
    onError(`invalid key '${key}'`);
    return null;
  }

  return [key, stripDotenvQuotes(rawValue)];
}

/**
 * The value `loadDotenvFromStateDir` would apply for `key` from this file
 * text when the key is not already set in the environment, or `undefined`
 * when the file does not define it. Same line parser; among duplicate
 * lines the first non-empty value wins (an empty value is overridden by a
 * later one, exactly as the loader's `process.env` check does). Read-only
 * callers (importers) use this instead of re-implementing the parse.
 */
export function dotenvTextValue(raw: string, key: string): string | undefined {
  let found: string | undefined;
  for (const line of raw.split(/\r?\n/)) {
    const parsed = parseDotenvLine(line, 0);
    if (parsed === null || parsed[0] !== key) continue;
    if (parsed[1].length > 0) return parsed[1];
    found = parsed[1];
  }
  return found;
}

/**
 * `KEY=VALUE` pairs of a `.env` text, parsed exactly as the loader
 * parses them (malformed lines are skipped silently). Used by the
 * secrets migration, which must move the same values the loader reads.
 */
export function parseDotenvText(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const parsed = parseDotenvLine(lines[i] ?? "", i + 1, () => {});
    if (parsed && !out.has(parsed[0])) out.set(parsed[0], parsed[1]);
  }
  return out;
}

/**
 * Read the file with a short retry loop. Windows antivirus and sync
 * clients hold transient locks that surface as EPERM/EBUSY for a few
 * milliseconds; two brief backoffs ride those out without noticeably
 * delaying startup (worst case ~200ms, only when the file exists and
 * is unreadable). Returns the raw text, `"missing"` for ENOENT, or the
 * failure that survived the loop.
 */
function readWithRetry(
  path: string,
  deps: DotenvIoDeps,
):
  | { kind: "ok"; raw: string }
  | { kind: "missing" }
  | { kind: "failed"; failure: DotenvReadFailure } {
  for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt += 1) {
    try {
      return { kind: "ok", raw: deps.readFile(path) };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? null;
      if (code === "ENOENT") return { kind: "missing" };
      const failure: DotenvReadFailure = { code, attempts: attempt };
      if (!code || !RETRYABLE_READ_CODES.has(code)) {
        return { kind: "failed", failure };
      }
      if (attempt === READ_ATTEMPTS) {
        return { kind: "failed", failure };
      }
      deps.sleep(
        READ_BACKOFF_MS[attempt - 1] ??
          READ_BACKOFF_MS[READ_BACKOFF_MS.length - 1] ??
          50,
      );
    }
  }
  // Unreachable: the loop always returns. Keeps tsc's control-flow happy.
  return { kind: "missing" };
}

/**
 * Human-readable warning for a `.env` that exists but could not be read.
 * Shown in the TUI chat and on stderr — must carry the path, the errno
 * code, and actionable platform-specific guidance, and must never carry
 * file content. `platform` is injectable for tests.
 */
export function formatDotenvReadWarning(
  path: string,
  failure: DotenvReadFailure,
  platform: NodeJS.Platform = process.platform,
): string {
  const attempts =
    failure.attempts === 1 ? "1 attempt" : `${failure.attempts} attempts`;
  const code = failure.code ?? "unknown error";
  const fix =
    platform === "win32"
      ? `Fix: clear the file's read-only attribute (right-click the file, Properties), add an antivirus exclusion for the folder, or reset its permissions: icacls "${path}" /reset`
      : `Fix: check the file's owner and permissions (ls -l "${path}"), then chmod 600 "${path}" as the user that runs atomic-agent.`;
  return [
    `Could not read secrets file: ${path} (${code} after ${attempts}).`,
    "Saved API keys and tokens from .env were NOT loaded this run.",
    fix,
  ].join("\n");
}

/**
 * Why the shell's value for a secret variable is unusable while the
 * file's value for it is fine, or `null` (the shell value stands). The
 * length rule applies only to the cloud vendors' own variables, whose
 * real keys are long.
 */
function malformedShellSecret(key: string, shellValue: string, fileValue: string): string | null {
  if (!isSecretVariableName(key) || fileValue.trim().length === 0) return null;
  const strictLength = STRICT_CLOUD_KEY_VARS.has(key);
  if (describeMalformedApiKey(fileValue, { strictLength }) !== null) return null;
  return describeMalformedApiKey(shellValue, { strictLength });
}

/**
 * Read `<stateDir>/.env` and merge its variables into `process.env`. Existing
 * `process.env` entries always win — shell-exported values take priority
 * over the file, except a secret variable whose shell value is a
 * placeholder while the file holds a well-formed one (`replacedPlaceholders`,
 * warned on stderr by name and length only). A missing file is a silent no-op (the common case for
 * users who do not need any secrets). A file that exists but cannot be
 * read is retried briefly and then reported both on stderr and in
 * `result.error` so frontends can warn loudly instead of silently
 * starting without secrets (#59).
 *
 * The loader has no external dependency and supports a deliberately tiny
 * subset of dotenv syntax: `KEY=VALUE` per line, optional surrounding
 * quotes (contents verbatim, no escapes), `#` line comments, blank
 * lines. No interpolation, no `export`
 * prefix, no multiline values. Add later if a real use case demands it.
 *
 * Returned `loaded` / `skipped` lists carry variable **names only** — values
 * never reach traces or logs through this surface.
 */
export function loadDotenvFromStateDir(
  stateDir: string,
  deps: Partial<DotenvIoDeps> & { keychain?: SecretKeychain } = {},
): DotenvLoadResult {
  const result = loadDotenvFile(stateDir, deps);
  // Opt-in OS keychain (ATO-474). Runs whether or not `.env` exists: a
  // full migration leaves no `.env` behind. In the default mode this is
  // one missing-file check and never loads the native binding.
  const keychain = loadKeychainSecrets(stateDir, deps.keychain);
  if (keychain) {
    result.keychain = keychain;
    result.loaded.push(...keychain.loaded);
    for (const key of keychain.skipped) {
      if (!result.loaded.includes(key) && !result.skipped.includes(key)) {
        result.skipped.push(key);
      }
    }
  }
  return result;
}

function loadDotenvFile(
  stateDir: string,
  deps: Partial<DotenvIoDeps>,
): DotenvLoadResult {
  const io: DotenvIoDeps = {
    readFile: deps.readFile ?? ((p) => decodeDotenvBytes(readFileSync(p))),
    sleep: deps.sleep ?? sleepSync,
  };
  const path = join(stateDir, ".env");
  const result: DotenvLoadResult = {
    path,
    exists: false,
    loaded: [],
    skipped: [],
    replacedPlaceholders: [],
    error: null,
  };

  const read = readWithRetry(path, io);
  if (read.kind === "missing") return result;
  if (read.kind === "failed") {
    result.error = read.failure;
    process.stderr.write(
      `atomic-agent: ${formatDotenvReadWarning(path, read.failure)}\n`,
    );
    return result;
  }

  result.exists = true;

  const text = read.raw.replace(/^\uFEFF/, "");
  let lines = text.split(/\r?\n/);
  if (text.includes("\u0000")) {
    // NUL bytes `decodeDotenvBytes` could not read as UTF-16: a damaged
    // or partly binary file. Its clean lines still load; the lines with
    // NULs are skipped, said once instead of a warning per line (and
    // never echoing the content).
    const clean = lines.filter((l) => !l.includes("\u0000"));
    const skipped = lines.length - clean.length;
    lines = clean;
    process.stderr.write(
      `atomic-agent: ${path} looks UTF-16/binary; save as UTF-8. ` +
        `${skipped} line${skipped === 1 ? "" : "s"} with NUL bytes ${skipped === 1 ? "was" : "were"} skipped this run.\n`,
    );
  }

  for (let i = 0; i < lines.length; i += 1) {
    const parsed = parseDotenvLine(lines[i] ?? "", i + 1, (reason) => {
      process.stderr.write(
        `atomic-agent: skipping ${path} entry — ${reason}\n`,
      );
    });
    if (parsed === null) continue;

    const [key, value] = parsed;
    const existing = process.env[key];
    if (existing !== undefined && existing.length > 0) {
      const bad = malformedShellSecret(key, existing, value);
      if (bad !== null) {
        // The one exception to "the shell wins": a placeholder left in
        // this shell (`$env:ANTHROPIC_API_KEY="..."` pasted from a doc)
        // would otherwise hide the valid key saved here and surface as
        // "the provider rejected the key".
        process.env[key] = value;
        result.replacedPlaceholders.push(key);
        process.stderr.write(
          `atomic-agent: ${key} in the environment ${bad} (${existing.trim().length} characters); using the value from .env\n`,
        );
        continue;
      }
      result.skipped.push(key);
      continue;
    }

    process.env[key] = value;
    result.loaded.push(key);
  }

  return result;
}
