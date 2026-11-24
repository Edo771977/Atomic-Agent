import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

import { isInside } from "../../approval/fanout-scope.js";
import { isTrustDirectoryEntry } from "../../config/config-file.js";
import { invocationsOf, NESTED_SHELL_PROGRAMS, programName, scanNestedShellOptions, splitCommandSegments } from "../os/shell-command-guard/command-segments.js";
import { checkShellCommandGuard } from "../os/shell-command-guard/index.js";
import { processSecretCommand } from "./process-secret-commands.js";
import { resolveUserPath } from "../os/expand-home.js";
import type { ToolContext } from "../tool-registry.js";
import { canonical } from "./read-scope.js";
import { shellCommandLine, type ShellScopeEnv } from "./read-scope-shell.js";
import { READ_TOOL_TARGETS, URL_LIKE } from "./read-scope-targets.js";

/**
 * The agent's own secret files, guarded on the way OUT (ATO-877).
 *
 * Writes to `config.json` and `.env` were always `trust_config`; reads
 * were not, and neither was a shell command. At level 4 the shell runs
 * unasked, so a prompt-injected `cat ~/.atomic-agent/.env` printed
 * every provider key into the transcript, and `sed -i … config.json`
 * could raise the approval level for the next boot without a question
 * (ATO-760). The environment filter (ATO-347) keeps keys out of a
 * child's environment; it cannot keep the child from opening the file.
 *
 * So a read-class tool whose target is one of these files, and a shell
 * command that names one, ask as `state_secret`: pinned at level 5 and
 * never grantable, like `trust_config`. The check runs at dispatch, in
 * the same registry wrapper as the read scope (`confine-reads.ts`), and
 * for every session whatever `agent.readScope` says.
 *
 * Read tools are checked exactly: the target is canonicalised, so a
 * symlink or a `..` detour to `.env` is caught. The shell check is
 * BEST-EFFORT, a token scan of the command line, not a parser: it sees
 * `~/…`, `$HOME/…`, `${HOME}/…`, `$ATOMIC_AGENT_STATE_DIR/…`, absolute
 * paths, paths relative to `cwd` (`cat .env` run inside the state
 * directory), quoted forms, globs (`~/.atomic-agent/*`) and the state
 * directory (or a folder of it that holds a secret) named as a whole —
 * `grep -r sk- ~/.atomic-agent`, `tar czf x.tgz ~/.atomic-agent`. It
 * does not see a path built at run time (`d=~/.atomic; cat ${d}-agent/.env`,
 * base64, a script file that opens it), or a recursive command run
 * inside the state directory without naming a path. Those are what
 * the remaining layers are for: the environment filter, and the output
 * masking of ATO-1077 (`src/tools/tool-output-secrets.ts`), which masks
 * the keys in whatever an approved read or a missed command prints.
 */

export interface StateSecrets {
  /** The agent's state directory (`config.paths.stateDir`). */
  stateDir: string;
  /**
   * Absolute files holding a secret or the trust config
   * (`getStateSecretPaths` in `src/config/config-file.ts`). Injected,
   * like `trustConfigPaths`: the tools layer never derives where the
   * agent keeps its keys. An entry ending in a path separator is a
   * directory of code the agent runs: a shell command naming anything
   * under it asks, a read tool does not (a skill's own files are meant
   * to be read).
   */
  files: readonly string[];
  /** Installed skill directories protected on recognized shell writes. */
  skillWritePaths?: readonly string[];
  /** Trust paths used to detect deletion of a containing folder. */
  trustDeletePaths?: readonly string[];
}

/**
 * Tools that take a directory's CONTENT, so naming a folder that holds a
 * secret reads it: a search walks it, and a move hands every file in it
 * to a path that is no longer a state path.
 */
const RECURSIVE_READ_TOOLS: ReadonlySet<string> = new Set(["os.fs.grep", "os.fs.move"]);

interface CanonicalSecrets {
  /** Each secret file, lexically resolved and canonicalised. */
  files: string[];
  /**
   * The folders a secret lives in, up to and including the state
   * directory: naming one hands its content over to a recursive reader.
   * Folders above the state directory (home, `/`) are not listed: a
   * home-wide search is out of this check's reach and its business.
   */
  folders: string[];
  /** Directories whose whole content a shell command must not touch unasked. */
  directories: string[];
}

function canonicalSecrets(secrets: StateSecrets): CanonicalSecrets {
  const lexicalState = resolve(secrets.stateDir);
  const states = [lexicalState, canonical(lexicalState)];
  const files = new Set<string>();
  const folders = new Set<string>();
  const directories = new Set<string>();
  for (const file of secrets.files) {
    const lexical = resolve(file);
    const directory = isTrustDirectoryEntry(file);
    // Both spellings: a command names the path it was told, a symlinked
    // state directory (`/tmp` vs `/private/tmp`) resolves elsewhere.
    for (const spelling of [lexical, canonical(lexical)]) {
      if (directory) {
        directories.add(spelling);
        folders.add(spelling);
      } else {
        files.add(spelling);
      }
      const state = states.find((dir) => isInside(dir, spelling));
      if (state === undefined) continue;
      for (let dir = dirname(spelling); isInside(state, dir); dir = dirname(dir)) {
        folders.add(dir);
        if (dir === dirname(dir)) break;
      }
    }
  }
  return { files: [...files], folders: [...folders], directories: [...directories] };
}

/** Same absolute path; via `relative`, so case-insensitive on Windows as the filesystem is. */
function samePath(a: string, b: string): boolean {
  return a === b || (isInside(a, b) && isInside(b, a));
}

/** The secret `path` names, or `null`: a file exactly, or (when `folders`) a folder holding one. */
function secretNamedBy(
  path: string,
  known: CanonicalSecrets,
  folders: boolean,
): string | null {
  const real = canonical(path);
  for (const file of known.files) {
    if (samePath(file, path) || samePath(file, real)) return file;
  }
  if (
    folders &&
    known.folders.some((dir) => samePath(dir, path) || samePath(dir, real))
  ) {
    return path;
  }
  return null;
}

/** The protected directory `path` lies in, or `null`. */
function directoryHolding(path: string, known: CanonicalSecrets): string | null {
  const real = canonical(path);
  return (
    known.directories.find((dir) => isInside(dir, path) || isInside(dir, real)) ??
    null
  );
}

/**
 * The secret files a read-class call targets (the `READ_TOOL_TARGETS`
 * argument of `tool`), deduplicated; empty when it touches none. A
 * recursive search (`os.fs.grep`) also counts when its root is a folder
 * of the state that holds a secret.
 */
export function findStateSecretReads(
  tool: string,
  args: Record<string, unknown>,
  ctx: Pick<ToolContext, "workingDir">,
  secrets: StateSecrets,
): string[] {
  const targetsOf = READ_TOOL_TARGETS.get(tool);
  if (targetsOf === undefined) return [];
  const known = canonicalSecrets(secrets);
  const hits = new Set<string>();
  for (const target of targetsOf(args)) {
    if (URL_LIKE.test(target)) continue;
    let path: string;
    try {
      path = resolveUserPath(target, ctx.workingDir);
    } catch {
      continue; // The tool refuses this path itself.
    }
    for (const envPath of [...processSecretPaths(path), ...processSecretPaths(canonical(path))]) hits.add(envPath);
    if (tool === "os.fs.grep" && isProcProcessDirectory(canonical(path))) hits.add(path);
    const hit = secretNamedBy(path, known, RECURSIVE_READ_TOOLS.has(tool));
    if (hit !== null) hits.add(hit);
  }
  return dedupe([...hits]);
}

const PROC_SECRETS = /(?:^|[^\w/.-])(\/proc\/[^/\s;"\u0060|<>&]+(?:\/task\/[^/\s;"\u0060|<>&]+)?\/([-\w.*?\[\]{}!,]+))(?=$|[^\w/.-])/g;

function processSecretPaths(text: string): string[] {
  return [...text.matchAll(PROC_SECRETS)]
    .filter(match => namesProcSecret(match[2]!))
    .map(match => match[1]!);
}

function namesProcSecret(name: string): boolean {
  return ["environ", "cmdline"].some(file => matchesName(name, file, "linux"));
}

/** Compile glob atoms plus nested brace lists, retaining empty alternatives. */
function matchesName(pattern: string, file: string, platform: NodeJS.Platform): boolean {
  const atom = (value: string) => globToRegExp(value, platform).source.slice(1, -1);
  function compile(value: string, depth: number): string {
    if (depth > 24) return atom(value);
    const open = value.indexOf("{");
    if (open < 0) return atom(value);
    const parts: string[] = [];
    let nested = 0;
    let start = open + 1;
    for (let index = start; index < value.length; index++) {
      const char = value[index];
      if (char === "{") nested++;
      if (char === "}") {
        if (nested === 0) {
          if (parts.length === 0) return atom(value.slice(0, index + 1)) + compile(value.slice(index + 1), depth + 1);
          parts.push(value.slice(start, index));
          return atom(value.slice(0, open)) + "(?:" + parts.map(part => compile(part, depth + 1)).join("|") +
            ")" + compile(value.slice(index + 1), depth + 1);
        }
        nested--;
      }
      if (char === "," && nested === 0) {
        parts.push(value.slice(start, index));
        start = index + 1;
      }
    }
    return atom(value);
  }
  try {
    return new RegExp("^" + compile(pattern, 0) + "$", platform === "win32" ? "i" : "").test(file);
  } catch {
    return false;
  }
}

function isProcProcessDirectory(path: string): boolean {
  return /^\/proc(?:\/(?:\d+|self|thread-self|[$*?][^/]*)(?:\/task(?:\/[^/]+)?)?)?$/.test(path);
}

/** Shell operators and grouping a path token ends at. */
const TOKEN_SPLIT = /[\s;|&<>()`{},]+/;
const GLOB = /[*?[]/;

/** `$HOME`, `${HOME}`, the state dir variable, and their Windows spellings, spelled out. */
function expandVariables(line: string, home: string, stateDir: string): string {
  return line
    .replace(/\$\{ATOMIC_AGENT_STATE_DIR\}|\$ATOMIC_AGENT_STATE_DIR\b/g, stateDir)
    .replace(/%ATOMIC_AGENT_STATE_DIR%|\$env:ATOMIC_AGENT_STATE_DIR\b/gi, stateDir)
    .replace(/\$\{HOME\}|\$HOME\b/g, home)
    .replace(/%USERPROFILE%|\$env:USERPROFILE\b|\$env:HOME\b/gi, home);
}

/** A glob token as a whole-path regular expression: `*` and `?` stay inside one segment. */
function globToRegExp(pattern: string, platform: NodeJS.Platform): RegExp {
  const sep = platform === "win32" ? "[\\\\/]" : "/";
  const notSep = platform === "win32" ? "[^\\\\/]" : "[^/]";
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i += 1;
      } else out += `${notSep}*`;
    } else if (c === "?") out += notSep;
    else if (c === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) out += "\\[";
      else {
        out += `[${pattern.slice(i + 1, close).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
        i = close;
      }
    } else if (c === "/" || (platform === "win32" && c === "\\")) out += sep;
    else out += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, platform === "win32" ? "i" : "");
}

/** What a word of the command names on disk, or `null` when it names nothing. */
function pathOfToken(token: string, cwd: string, home: string): string | null {
  // `--env-file=…`, `FOO=…`, `curl -d @…`: the value is the path.
  let t = token;
  const eq = t.indexOf("=");
  if (eq >= 0) t = t.slice(eq + 1);
  t = t.replace(/^@/, "");
  if (t.length === 0 || URL_LIKE.test(t)) return null;
  if (t === "~") return home;
  if (t.startsWith("~/") || t.startsWith("~\\")) return resolve(home, t.slice(2));
  return isAbsolute(t) ? resolve(t) : resolve(cwd, t);
}

/** Recognize CLI invocations even with a wrapper in front of the binary. */
function managesHttpTokens(line: string, depth = 0): boolean {
  if (depth > 8) return false;
  // Resolve common shell lookups lexically. Never invoke a shell or resolve a binary here.
  const segments = splitCommandSegments(line.replace(
    /(?:\$\(\s*(?:command\s+-v|which|type\s+-P)\s+((?:atomic-agent|atag)(?:\.exe)?)\s*\)|`\s*(?:command\s+-v|which|type\s+-P)\s+((?:atomic-agent|atag)(?:\.exe)?)\s*`)/gi,
    (_, substitution, backticks) => substitution ?? backticks,
  ));
  const management = ([group, command]: readonly string[]) => group === "http" && command === "tokens";
  if (["atag", "atag.cmd", "atomic-agent", "atomic-agent.cmd"].some(program =>
    invocationsOf(segments, program).some(management))) return true;
  if (invocationsOf(segments, "node").some(args =>
    args.some((word, index) => /(?:^|[\\/])(?:src|dist)[\\/]cli[\\/]index\.(?:ts|js)$/.test(word)
      && management(args.slice(index + 1))))) return true;
  return NESTED_SHELL_PROGRAMS.some(program => invocationsOf(segments, program).some(args =>
    scanNestedShellOptions(args, program).scripts.some(script => managesHttpTokens(script, depth + 1))));
}

/**
 * The secret files (or secret-holding folders of the state) a shell
 * call names, deduplicated; empty when it names none. Best-effort, see
 * the module comment for what it does not see.
 */
export function findShellStateSecrets(
  args: Record<string, unknown>,
  ctx: Pick<ToolContext, "workingDir">,
  secrets: StateSecrets,
  env: ShellScopeEnv = { home: homedir(), platform: process.platform },
): string[] {
  const known = canonicalSecrets(secrets);
  let cwd = ctx.workingDir;
  if (typeof args.cwd === "string" && args.cwd.length > 0) {
    try {
      cwd = resolveUserPath(args.cwd, ctx.workingDir);
    } catch {
      cwd = ctx.workingDir;
    }
  }
  let line = expandVariables(shellCommandLine(args), env.home, secrets.stateDir);
  const segments = splitCommandSegments(line);
  // Quotes only group; on POSIX a backslash only escapes.
  line = line.replace(/["']/g, "");
  if (env.platform !== "win32") line = line.replace(/\\/g, "");

  const hits = new Set(processSecretPaths(line));
  if (managesHttpTokens(line)) {
    for (const file of known.files) {
      if (/(?:^|[\\/])http-tokens\.json$/i.test(file)) hits.add(file);
    }
  }
  const nameTokens = line.split(/[\s;|&<>()`]+/);
  for (const filename of ["serve-api.key", "http-tokens.json"]) {
    const literal = new RegExp(`(^|[^\\w.-])${filename.replace(".", "\\.")}(?=$|[^\\w.-])`, "i");
    if (literal.test(line) || nameTokens.some(token => {
      const name = token.split(/[\\/=]/).at(-1) ?? "";
      return name !== "*" && matchesName(name, filename, env.platform);
    })) {
      for (const file of known.files) {
        if (file.split(/[\\/]/).at(-1)?.toLowerCase() === filename) hits.add(file);
      }
    }
  }
  // Track simple directory changes and inspect paths after lifting shell substitutions.
  let procCwd = cwd;
  for (const [command, ...words] of segments) {
    if (command === undefined) continue;
    const program = programName(command);
    if ((program === "cd" || program === "pushd") && words.length === 1) {
      procCwd = pathOfToken(words[0]!, procCwd, env.home) ?? cwd;
      continue;
    }
    if (program === "popd") procCwd = cwd;
    const recursive = program === "find" || program === "rg" || (program === "grep" &&
      words.some(word => /^-[A-Za-z]*[rR][A-Za-z]*$/.test(word) || /^--(?:recursive|dereference-recursive)$/.test(word)));
    for (const token of words) {
      const path = pathOfToken(token, procCwd, env.home);
      if (path === null) continue;
      for (const resource of processSecretPaths(path)) hits.add(resource);
      if (recursive && isProcProcessDirectory(path)) hits.add(path);
    }
  }
  const processCommand = processSecretCommand(segments);
  if (processCommand) hits.add("process environment or arguments (" + processCommand + ")");
  // A secret spelled out in full anywhere on the line, glued to code
  // (`python3 -c open(/…/.env)`) or not.
  for (const file of [...known.files, ...known.directories]) {
    if (spelledOut(line, file)) hits.add(file);
  }
  const candidates = [...known.files, ...known.folders];
  for (const token of line.split(TOKEN_SPLIT)) {
    if (token.length === 0) continue;
    const path = pathOfToken(token, cwd, env.home);
    if (path === null) continue;
    for (const envPath of [...processSecretPaths(path), ...processSecretPaths(canonical(path))]) hits.add(envPath);
    if (GLOB.test(path)) {
      const pattern = globToRegExp(path, env.platform);
      for (const candidate of candidates) {
        if (pattern.test(candidate)) hits.add(candidate);
      }
      continue;
    }
    const hit = secretNamedBy(path, known, true) ?? directoryHolding(path, known);
    if (hit !== null) hits.add(hit);
  }
  return dedupe([...hits]);
}

/** Recognized writes to server key paths use the trust-config approval. */
export function shellServerKeyMutation(
  args: Record<string, unknown>,
  ctx: Pick<ToolContext, "workingDir">,
  secrets: StateSecrets,
  env?: ShellScopeEnv,
): boolean {
  const files = secrets.files.filter(path => /(?:^|[\\/])(?:(?:serve-api|llama-server)\.key|http-tokens\.json)$/i.test(path));
  if (files.length === 0) return false;
  const line = shellCommandLine(args);
  if (files.some(path => /(?:^|[\\/])http-tokens\.json$/i.test(path)) &&
      managesHttpTokens(line)) return true;
  return line.split(/[;|&\n]+/).some(cmd => {
    return isShellWrite(cmd) &&
      findShellStateSecrets({ cmd, cwd: args.cwd }, ctx, { ...secrets, files }, env).length > 0;
  });
}

function isShellWrite(command: string): boolean {
  const writes = /(^|[\s\\/"'])(?:rm|rmdir|mkdir|mv|cp|rsync|patch|touch|truncate|tee|chmod|chown|ln|install|unlink|del|erase|move|ren|copy|set-content|add-content|clear-content|remove-item|move-item|copy-item|rename-item|out-file|new-item)(?=\s|["'])/i;
  return writes.test(command) || /(?:^|[\s/])sed(?=\s)[^\n]*\s-i\S*(?=\s|$)/.test(command) ||
    /(^|[^<])>/.test(command);
}

export function findShellSkillWrites(
  args: Record<string, unknown>,
  ctx: Pick<ToolContext, "workingDir">,
  secrets: StateSecrets,
  env?: ShellScopeEnv,
): string[] {
  const files = secrets.skillWritePaths;
  if (!files?.length) return [];
  return [...new Set(shellCommandLine(args).split(/[;|&\n]+/).flatMap((cmd) =>
    isShellWrite(cmd) ? findShellStateSecrets({ cmd, cwd: args.cwd }, ctx, { stateDir: secrets.stateDir, files }, env) : [],
  ))];
}

const DELETE_PROGRAMS = ["rm", "rmdir", "unlink", "del", "erase", "rd", "remove-item"];

export function findShellTrustDeletes(
  args: Record<string, unknown>,
  ctx: Pick<ToolContext, "workingDir">,
  secrets: StateSecrets,
  env: ShellScopeEnv = { home: homedir(), platform: process.platform },
): string[] {
  if (!secrets.trustDeletePaths?.length) return [];
  const cwd = typeof args.cwd === "string" ? resolveUserPath(args.cwd, ctx.workingDir) : ctx.workingDir;
  const segments = splitCommandSegments(expandVariables(shellCommandLine(args), env.home, secrets.stateDir));
  const words = DELETE_PROGRAMS.flatMap((program) =>
    invocationsOf(segments, program)
      .filter((rawArgs) => checkShellCommandGuard({ cmd: program, rawArgs, cwd }).action !== "block")
      .flat(),
  );
  const targets = words.filter((word) => !word.startsWith("-")).flatMap((word) => {
    const path = pathOfToken(word, cwd, env.home);
    return path === null ? [] : [canonical(path)];
  });
  return secrets.trustDeletePaths.filter((trusted) => {
    const path = canonical(resolve(trusted));
    return targets.some((target) => isInside(target, path) ||
      (isTrustDirectoryEntry(trusted) && isInside(path, target)));
  });
}

/** `file` appears in `line` as a whole path: not `.env` inside `.env.example`. */
function spelledOut(line: string, file: string): boolean {
  for (let at = line.indexOf(file); at !== -1; at = line.indexOf(file, at + 1)) {
    const next = line[at + file.length];
    if (next === undefined || !/[\w.-]/.test(next)) return true;
  }
  return false;
}

/** One entry per file: the lexical and canonical spellings of a path collapse. */
function dedupe(paths: string[]): string[] {
  const out: string[] = [];
  for (const path of paths) {
    const real = canonical(path);
    if (!out.some((seen) => samePath(canonical(seen), real))) out.push(path);
  }
  return out;
}

/** The prompt for a read of a secret file. */
export function stateSecretReadPrompt(paths: readonly string[]): string {
  return (
    `read ${paths.join(", ")} — the agent's own secret file (API keys, ` +
    `tokens, approval settings); asked every time, never granted for the session`
  );
}

/** The prompt for a shell command that names a secret file. */
export function stateSecretShellPrompt(
  commandLine: string,
  paths: readonly string[],
): string {
  return (
    `run \`${commandLine}\` — it names the agent's own secret files ` +
    `(API keys, tokens, approval settings, hooks, plugins): ${paths.join(", ")}; ` +
    `asked every time, never granted for the session`
  );
}
