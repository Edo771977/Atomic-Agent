import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, rmdirSync, type Stats } from "node:fs";
import { join } from "node:path";

import { renameWithRetrySync, syncDirectoryBestEffort, writeFileSyncedSync } from "../config/durable-write.js";
import { hasOwnerOnlyWindowsAcl, restrictWindowsAcl } from "../config/windows-acl.js";
import { isHttpRole, type HttpRole } from "./http-scopes.js";

/**
 * ATO-583: `<stateDir>/http-tokens.json`, the named API tokens of
 * `atag serve` (`atag http tokens add|list|remove`). Only a SHA-256 of each
 * token is stored; the token itself is printed once when it is made, the
 * way GitHub and OpenAI show a new key. Owner-only (0600), written with a
 * temp file and a rename.
 */
export const HTTP_TOKENS_FILE = "http-tokens.json";

/** Tokens start with this, so a leaked one is easy to search for. */
export const HTTP_TOKEN_PREFIX = "atag_";

const TOKEN_PATTERN = /atag_[A-Za-z0-9_-]{43}/;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface StoredHttpToken {
  name: string;
  role: HttpRole;
  /** Hex SHA-256 of the token. */
  sha256: string;
  createdAt: string;
}

export type HttpTokensRead =
  | { ok: true; tokens: StoredHttpToken[] }
  | { ok: false; error: string };

export function httpTokensPath(stateDir: string): string {
  return join(stateDir, HTTP_TOKENS_FILE);
}

export function hashHttpToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function isValidHttpTokenName(name: string): boolean {
  return NAME_PATTERN.test(name) && !TOKEN_PATTERN.test(name);
}

function parseToken(raw: unknown): StoredHttpToken | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || !isValidHttpTokenName(r.name)) return null;
  if (!isHttpRole(r.role)) return null;
  if (typeof r.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(r.sha256)) return null;
  if (typeof r.createdAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(r.createdAt)) return null;
  const createdAt = r.createdAt;
  return { name: r.name, role: r.role, sha256: r.sha256, createdAt };
}

function isPrivateFile(st: Stats): boolean {
  return st.isFile() && st.nlink === 1 &&
    (process.platform === "win32" ||
      ((st.mode & 0o7177) === 0 && st.uid === process.getuid?.()));
}

function readRegistryFile(path: string): string {
  const before = lstatSync(path);
  if (!isPrivateFile(before) ||
      (process.platform === "win32" && !hasOwnerOnlyWindowsAcl(path))) {
    throw new Error("expected an owner-only regular file without links");
  }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!isPrivateFile(opened) || before.dev !== opened.dev || before.ino !== opened.ino) {
      throw new Error("file changed while opening");
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/** The file as it is now. A missing file is an empty list, a broken one an error. */
export function readHttpTokens(stateDir: string): HttpTokensRead {
  let text: string;
  try {
    text = readRegistryFile(httpTokensPath(stateDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, tokens: [] };
    return { ok: false, error: `cannot read ${HTTP_TOKENS_FILE}: ${(err as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: `${HTTP_TOKENS_FILE} is not valid JSON` };
  }
  const registry = parsed as { version?: unknown; tokens?: unknown } | null;
  if (registry?.version !== 1) return { ok: false, error: `${HTTP_TOKENS_FILE} has an unsupported version` };
  const list = registry.tokens;
  if (!Array.isArray(list)) return { ok: false, error: `${HTTP_TOKENS_FILE} has no "tokens" list` };
  const tokens: StoredHttpToken[] = [];
  for (const entry of list) {
    const token = parseToken(entry);
    if (!token) return { ok: false, error: `${HTTP_TOKENS_FILE} has an entry that is not a valid token` };
    tokens.push(token);
  }
  return { ok: true, tokens };
}

function writeHttpTokens(stateDir: string, tokens: StoredHttpToken[]): void {
  const path = httpTokensPath(stateDir);
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSyncedSync(tmp, `${JSON.stringify({ version: 1, tokens }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  try {
    if (process.platform === "win32") {
      restrictWindowsAcl(tmp);
      if (!hasOwnerOnlyWindowsAcl(tmp)) throw new Error("could not restrict token registry ACL");
    }
    renameWithRetrySync(tmp, path);
    syncDirectoryBestEffort(stateDir);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function editHttpTokens<T>(
  stateDir: string,
  edit: (tokens: StoredHttpToken[]) => T | { ok: false; error: string },
): T | { ok: false; error: string } {
  const lock = `${httpTokensPath(stateDir)}.lock`;
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    mkdirSync(lock, { mode: 0o700 });
  } catch (err) {
    const error = (err as NodeJS.ErrnoException).code === "EEXIST"
      ? "token registry is locked by another edit"
      : "cannot lock the token registry";
    return { ok: false, error };
  }
  try {
    const current = readHttpTokens(stateDir);
    if (!current.ok) return current;
    return edit(current.tokens);
  } catch {
    return { ok: false, error: "cannot update the token registry" };
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      // A completed write remains valid. A leftover lock blocks later edits.
    }
  }
}

export type AddHttpTokenResult =
  | { ok: true; token: string; entry: StoredHttpToken }
  | { ok: false; error: string };

/** Make a token, store its hash, and hand the token back (the only time it exists in clear). */
export function addHttpToken(
  stateDir: string,
  name: string,
  role: HttpRole,
  now: () => Date = () => new Date(),
): AddHttpTokenResult {
  if (!isValidHttpTokenName(name)) {
    return { ok: false, error: `invalid token name "${name}": use letters, digits, ".", "_" or "-" (up to 64)` };
  }
  return editHttpTokens<AddHttpTokenResult>(stateDir, (tokens) => {
    if (tokens.some((t) => t.name === name)) {
      return { ok: false, error: `a token named "${name}" already exists; remove it first` };
    }
    const token = `${HTTP_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const entry: StoredHttpToken = { name, role, sha256: hashHttpToken(token), createdAt: now().toISOString() };
    writeHttpTokens(stateDir, [...tokens, entry]);
    return { ok: true, token, entry };
  });
}

export type RemoveHttpTokenResult = { ok: true } | { ok: false; error: string };

export function removeHttpToken(stateDir: string, name: string): RemoveHttpTokenResult {
  return editHttpTokens<RemoveHttpTokenResult>(stateDir, (tokens) => {
    if (!tokens.some((t) => t.name === name)) {
      return { ok: false, error: `no token named "${name}"` };
    }
    writeHttpTokens(stateDir, tokens.filter((t) => t.name !== name));
    return { ok: true };
  });
}

/**
 * The tokens serve checks requests against, read again whenever the file
 * changes, so `add` and `remove` apply without restarting serve. A broken
 * or unreadable file yields no named tokens: only the serve key works then.
 */
export function createHttpTokenSource(stateDir: string): () => readonly StoredHttpToken[] {
  const path = httpTokensPath(stateDir);
  let stamp = "";
  let cached: readonly StoredHttpToken[] = [];
  return () => {
    let next: string;
    try {
      const st = lstatSync(path);
      if (!isPrivateFile(st)) throw new Error("insecure token registry");
      next = `${st.dev}:${st.ino}:${st.ctimeMs}:${st.mtimeMs}:${st.size}`;
    } catch {
      stamp = "";
      cached = [];
      return cached;
    }
    if (next !== stamp) {
      const read = readHttpTokens(stateDir);
      cached = read.ok ? read.tokens : [];
      stamp = read.ok ? next : "";
    }
    return cached;
  };
}
