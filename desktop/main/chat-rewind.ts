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
 * tried again. Each list holds at most REWIND_LIST_CAP entries; the totals
 * count them all.
 */
export type RewindPartial = {
  restored: string[];
  deleted: string[];
  failed: Array<{ path: string; error?: string }>;
  restoredTotal: number;
  deletedTotal: number;
  failedTotal: number;
};

export type RewindAnswer =
  | { ok: true; supported: true; data: Record<string, unknown> }
  | { ok: false; supported: boolean; code?: string; error: string; restore?: RewindPartial };

export const REWIND_LIST_CAP = 100;
const REWIND_ERROR_CAP = 300;

/** The `{path, error?}` entries of a partial-restore list that have a path. */
function rewindFileList(value: unknown): Array<{ path: string; error?: string }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ path: string; error?: string }> = [];
  for (const item of value) {
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
    failed: failed.slice(0, REWIND_LIST_CAP),
    restoredTotal: restored.length,
    deletedTotal: deleted.length,
    failedTotal: failed.length,
  };
}

/**
 * The body the window may send: a non-negative whole position, the question's
 * text and, for a rollback, whether the files go back too (`files: false` is
 * the conversation only; left out, the agent puts the files back).
 */
export function rewindRequestBody(
  priorQuestions: unknown,
  expectText: unknown,
  files?: unknown,
): { priorQuestions: number; expectText: string; files?: boolean } | null {
  if (typeof priorQuestions !== "number" || !Number.isInteger(priorQuestions) || priorQuestions < 0) return null;
  if (typeof expectText !== "string" || !expectText.trim()) return null;
  return typeof files === "boolean" ? { priorQuestions, expectText, files } : { priorQuestions, expectText };
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
  return { ok: false, supported: true, ...(code ? { code } : {}), error: message || `HTTP ${status}` };
}
