/**
 * ATO-1056 / ATO-1058 — the pure half of "Roll back here", "Edit" and "Fork
 * from here" (renderer/chat-rewind.js): what the window may ask for, and the
 * agent's answer in the shape the window reads.
 *
 * The agent's routes (src/http/route-session-rewind.ts):
 *   POST /api/sessions/{id}/rewind/preview   what a rollback would change
 *   POST /api/sessions/{id}/rewind           files first, then the chat
 *   POST /api/sessions/{id}/fork             a new chat through that question's answer
 * Each takes `{ priorQuestions, expectText }`, the question by its position
 * and its text. Its own 404 is an unknown chat (`session_not_found`); an agent
 * without the routes answers its unknown-route 404 with no code, which reads
 * as unsupported so the window hides the buttons. A rollback that put back
 * only some files answers 409 `restore_failed` with what was put back and
 * what was not (RewindPartial; the chat is not cut).
 */

export type RewindRoute = "rewind/preview" | "rewind" | "fork";

/**
 * Issue #77: a rollback that put back only some files (409 `restore_failed`).
 * The agent left the chat as it was and kept its saved copies, so it can be
 * tried again. Another refusal that comes after files were put back (the
 * chat changed, a turn started) carries the same lists. `restored` and
 * `deleted` hold at most REWIND_LIST_CAP entries; `failed` holds up to
 * REWIND_SKIP_CAP, so all of them can be sent back as `skip` (issue #80).
 * The totals count them all.
 */
export type RewindPartial = {
  restored: string[];
  deleted: string[];
  failed: Array<{ path: string; error?: string }>;
  restoredTotal: number;
  deletedTotal: number;
  failedTotal: number;
  /**
   * Issue #80: the paths the agent says it left alone for `skip`. An agent
   * that knows `skip` sends this list (possibly empty) in every
   * restore_failed body; one that does not leaves it out, so its absence
   * means `skip` would be ignored.
   */
  skipped?: string[];
};

export type RewindAnswer =
  | { ok: true; supported: true; data: Record<string, unknown> }
  | { ok: false; supported: boolean; code?: string; error: string; restore?: RewindPartial };

export const REWIND_LIST_CAP = 100;
/** Issue #80: the most paths a rollback's `skip` may name. */
export const REWIND_SKIP_CAP = 1000;
const REWIND_ERROR_CAP = 300;

/**
 * The entries of a restore list that name a path. The agent sends `restored`
 * and `deleted` as path strings and `failed` as `{path, error}`
 * (applyFileRestore); either form is read for any list.
 */
function rewindFileList(value: unknown): Array<{ path: string; error?: string }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ path: string; error?: string }> = [];
  for (const item of value) {
    if (typeof item === "string") {
      if (item) out.push({ path: item });
      continue;
    }
    if (typeof item !== "object" || item === null) continue;
    const { path, error } = item as { path?: unknown; error?: unknown };
    if (typeof path !== "string" || !path) continue;
    out.push(typeof error === "string" && error ? { path, error: error.slice(0, REWIND_ERROR_CAP) } : { path });
  }
  return out;
}

function rewindPartial(record: Record<string, unknown> | null): RewindPartial {
  const restored = rewindFileList(record?.restored);
  const deleted = rewindFileList(record?.deleted);
  const failed = rewindFileList(record?.failed);
  return {
    restored: restored.slice(0, REWIND_LIST_CAP).map((f) => f.path),
    deleted: deleted.slice(0, REWIND_LIST_CAP).map((f) => f.path),
    failed: failed.slice(0, REWIND_SKIP_CAP),
    restoredTotal: restored.length,
    deletedTotal: deleted.length,
    failedTotal: failed.length,
    ...(Array.isArray(record?.skipped) ? { skipped: rewindFileList(record?.skipped).slice(0, REWIND_SKIP_CAP).map((f) => f.path) } : {}),
  };
}

/**
 * Issue #80: the paths a rollback leaves alone, exactly as the agent named
 * them in `failed[].path`: undefined when there are none, null when the value
 * is not a list of at most REWIND_SKIP_CAP non-empty strings.
 */
export function rewindSkipList(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > REWIND_SKIP_CAP) return null;
  if (!value.every((p) => typeof p === "string" && p.length > 0)) return null;
  return value.length ? [...(value as string[])] : undefined;
}

/**
 * The body the window may send: a non-negative whole position, the question's
 * text and, for a rollback, whether the files go back too (`files: false` is
 * the conversation only; left out, the agent puts the files back) and the
 * files to leave as they are (`skip`, issue #80: the person chose to go ahead
 * without the ones a partial restore could not put back). `acceptFailed`
 * (boolean) is sent only to an agent whose partial answer shows it does not
 * know `skip` (no `skipped` list): it plans every file again. A `skip` that
 * is not a valid list refuses the body (null).
 */
export function rewindRequestBody(
  priorQuestions: unknown,
  expectText: unknown,
  files?: unknown,
  skip?: unknown,
  acceptFailed?: unknown,
): { priorQuestions: number; expectText: string; files?: boolean; skip?: string[]; acceptFailed?: boolean } | null {
  if (typeof priorQuestions !== "number" || !Number.isInteger(priorQuestions) || priorQuestions < 0) return null;
  if (typeof expectText !== "string" || !expectText.trim()) return null;
  const skipped = rewindSkipList(skip);
  if (skipped === null) return null;
  return {
    priorQuestions,
    expectText,
    ...(typeof files === "boolean" ? { files } : {}),
    ...(skipped ? { skip: skipped } : {}),
    ...(typeof acceptFailed === "boolean" ? { acceptFailed } : {}),
  };
}

/** The agent's answer to one of the routes, as the window reads it. */
export function rewindAnswer(status: number, body: unknown): RewindAnswer {
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  const error = record && typeof record.error === "object" && record.error !== null ? (record.error as Record<string, unknown>) : null;
  const message = typeof error?.message === "string" ? error.message : "";
  const code = typeof error?.code === "string" && error.code ? error.code : undefined;
  if (status >= 200 && status < 300 && record) return { ok: true, supported: true, data: record };
  if (status === 404) {
    if (code === "session_not_found" || /session not found/i.test(message)) {
      return { ok: false, supported: true, code: "session_not_found", error: "This chat is not saved yet" };
    }
    return { ok: false, supported: false, error: "This agent version cannot roll back or fork a chat" };
  }
  if (code === "restore_failed") return { ok: false, supported: true, code, error: message || `HTTP ${status}`, restore: rewindPartial(record) };
  // Another refusal (the chat changed, a turn started) can come after files were put back: it says which.
  const partial = rewindPartial(record);
  const changed = partial.restoredTotal + partial.deletedTotal + partial.failedTotal > 0;
  return { ok: false, supported: true, ...(code ? { code } : {}), error: message || `HTTP ${status}`, ...(changed ? { restore: partial } : {}) };
}
