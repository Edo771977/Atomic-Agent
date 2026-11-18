/**
 * The shape a session id taken from outside the process must have (issue
 * #74). A session id becomes a file name — the trace
 * `<traces>/<id>.ndjson`, archived turns, fusion checkpoints — so an
 * ingress (HTTP chat completions and its compat routes, AG-UI threads,
 * `/api/sessions/{id}`, the sidecar) refuses anything that is not one
 * plain token: a letter or digit first, then letters, digits, `.`, `_`
 * and `-`, at most {@link SESSION_ID_MAX_LENGTH} characters. No path
 * separators, no `..`, no colon (a Windows alternate data stream), no
 * controls or spaces. The runtime's own ids (`s-<uuid>`, `s-w-<uuid>`,
 * `api-<hex>`) all fit.
 */
export const SESSION_ID_MAX_LENGTH = 128;

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Why `value` is not an acceptable session id, or `null` when it is. */
export function sessionIdError(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return "session id must be a non-empty string";
  if (value.length > SESSION_ID_MAX_LENGTH) {
    return `session id must be at most ${SESSION_ID_MAX_LENGTH} characters`;
  }
  if (!SESSION_ID_PATTERN.test(value)) {
    return "session id may hold only letters, digits, '.', '_' and '-', and must start with a letter or digit";
  }
  return null;
}

export function isValidSessionId(value: unknown): value is string {
  return sessionIdError(value) === null;
}
