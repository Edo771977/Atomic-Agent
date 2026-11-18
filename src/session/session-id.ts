import { createHash } from "node:crypto";

/**
 * The shape a session id taken from outside the process must have (issue
 * #74). The store holds more than the runtime's own ids (`s-<uuid>`,
 * `s-w-<uuid>`, `api-<hex>`): imported chats are `<tool>:<source id>`
 * (`claude-code:`, `codex:`, `claude-app:`, `hermes:`, `pi:`, `oh-my-pi:`,
 * `openclaw:`, `src/import/`), with whatever characters the source tool
 * used. So an ingress (HTTP chat completions and its compat routes, AG-UI
 * threads, `/api/sessions/{id}`, the sidecar) refuses only what can turn
 * an id into a path or a broken line: an empty id, more than
 * {@link SESSION_ID_MAX_LENGTH} characters, `/` or `\`, `..`, a leading
 * `.`, and control characters (NUL, CR, LF, tab, DEL, …).
 *
 * An id never becomes a file name as it is: {@link sessionFileName} maps
 * it to one that is safe on every filesystem.
 */
export const SESSION_ID_MAX_LENGTH = 256;

/** Why `value` is not an acceptable session id, or `null` when it is. */
export function sessionIdError(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return "session id must be a non-empty string";
  if (value.length > SESSION_ID_MAX_LENGTH) {
    return `session id must be at most ${SESSION_ID_MAX_LENGTH} characters`;
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) return "session id may not hold control characters";
  if (/[/\\]/.test(value)) return "session id may not hold '/' or '\\'";
  if (value.startsWith(".") || value.includes("..")) return "session id may not start with '.' or hold '..'";
  return null;
}

export function isValidSessionId(value: unknown): value is string {
  return sessionIdError(value) === null;
}

/** Characters a file name keeps as they are; everything else is escaped. */
const PLAIN_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
/** Longest escaped name kept readable; a longer one becomes a digest. */
const FILE_NAME_MAX = 200;

/**
 * The file-name form of a session id (issue #74): stable, collision-free
 * and safe on every filesystem, so `:` never reaches a Windows path (an
 * alternate data stream) and no id can name a path.
 *
 *  - An id of only `[A-Za-z0-9._-]` not starting with `.` is unchanged,
 *    so every runtime id keeps the file it always had.
 *  - Otherwise each UTF-8 byte outside that set (and a leading `.`) is
 *    written `~xx` (two lowercase hex digits); `~` itself is escaped, so
 *    the mapping is reversible and two ids never share a name.
 *  - An escaped name longer than 200 characters is `~h` and the id's
 *    SHA-256: `h` is no hex digit, so it cannot be an escaped name.
 */
export function sessionFileName(sessionId: string): string {
  if (sessionId.length <= FILE_NAME_MAX && PLAIN_NAME.test(sessionId)) return sessionId;
  let out = "";
  const bytes = Buffer.from(sessionId, "utf8");
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]!;
    const ch = String.fromCharCode(byte);
    const keep = byte < 0x80 && /[A-Za-z0-9._-]/.test(ch) && !(i === 0 && ch === ".");
    out += keep ? ch : `~${byte.toString(16).padStart(2, "0")}`;
  }
  if (out.length <= FILE_NAME_MAX) return out;
  return `~h${createHash("sha256").update(sessionId, "utf8").digest("hex")}`;
}

/**
 * The session id a {@link sessionFileName} came from, or `null` for a
 * digest name (the id is in the file's own records). A name with no `~`
 * is returned as it is, which also reads files older builds named with
 * the raw id; so is a name holding `~` that `sessionFileName` would not
 * have produced (issue #74 review).
 */
export function sessionIdFromFileName(name: string): string | null {
  if (!name.includes("~")) return name;
  if (/^~h[0-9a-f]{64}$/.test(name)) return null;
  if (!/^(?:[^~]|~[0-9a-f]{2})*$/.test(name)) return name;
  const bytes: number[] = [];
  for (let i = 0; i < name.length; i++) {
    if (name[i] === "~") {
      bytes.push(Number.parseInt(name.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(name.charCodeAt(i));
    }
  }
  const decoded = Buffer.from(bytes).toString("utf8");
  // Only a name sessionFileName itself produces is decoded; anything else
  // (a raw id an older build wrote that happens to hold `~xx`) is the id.
  return sessionFileName(decoded) === name ? decoded : name;
}
