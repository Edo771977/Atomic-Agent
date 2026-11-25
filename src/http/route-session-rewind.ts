import { releasePrivacyVault } from "../privacy/index.js";
import type { ServerResponse } from "node:http";

import type { ConversationTurn } from "../session/conversation-turn.js";
import { planFork, questionRowIndex, type ForkRefusal } from "../session/session-fork.js";
import { listRewindPoints, planRewind, type RewindRefusal } from "../session/session-rewind.js";
import type { SessionState } from "../session/session-state.js";
import {
  applyFileRestore,
  planFileRestore,
  restorePlanHash,
  uncoveredToolCalls,
} from "../tools/os/fs/fs-checkpoint-restore.js";
import { FileCheckpointStore, fileCheckpointsRoot, sha256Of } from "../tools/os/fs/fs-checkpoint-store.js";
import { openaiError } from "./openai-errors.js";
import { readJsonBody, sendError, sendJson, type HandlerContext, type HttpHandler } from "./request-context.js";

/**
 * Taking a chat back to one of its questions with its files, and forking
 * it from one (ATO-1056, ATO-1058):
 *
 *  - `GET  /api/sessions/{id}/rewind-points` — the questions it can go back to.
 *  - `POST /api/sessions/{id}/rewind/preview` — what a rollback would do.
 *  - `POST /api/sessions/{id}/rewind` — do it: files first, then the chat.
 *  - `POST /api/sessions/{id}/fork` — a new chat with the history through that question's answer.
 *
 * A question is named the way `rollback-last-turn` names one: `priorQuestions`
 * (how many questions come before it, steers not counted) and `expectText`.
 * A different stored question refuses (`409 point_mismatch`) and changes
 * nothing. Editing a sent message is a rollback to it followed by a normal
 * send of the new text; it needs no route of its own.
 *
 * Only changes made by the agent's own file tools are put back
 * (`fs-checkpoint-store.ts`); the preview lists the shell commands, git
 * commands, archive extractions and Fusion runs whose changes stay.
 */

/**
 * `restore_failed` (issue #77): a file could not be put back. The chat is
 * not cut and the saved copies stay, so the same rollback can be sent
 * again; files already back match their copy and are not planned again.
 * A failure that repeats (a folder replaced by a file, a file an editor
 * holds open) is not told apart from a transient one: `acceptFailed: true`
 * rolls back anyway, leaving the files that failed as they are.
 */
type Refusal = RewindRefusal | ForkRefusal | "restore_failed" | "plan_changed";

const REFUSAL_MESSAGES: Record<Refusal, string> = {
  nothing_to_rewind: "this chat has no question to go back to",
  turn_in_progress: "this chat has a turn in progress; try again when it finishes",
  point_compacted: "that message is inside the part of the chat already compacted into a summary",
  incognito: "an incognito chat cannot be forked: it leaves nothing behind, a copy included",
  point_mismatch: "the chat's question at that position is not the one given (priorQuestions, expectText), so nothing was changed",
  plan_changed:
    "the files or the messages changed since the preview (an edit, another turn that changed more files or added messages), so the rollback would not do what the preview showed; nothing was changed. Check the preview again",
  restore_failed:
    "some files could not be put back (see failed); the chat was not cut and the saved copies were kept. Try the rollback again, or send acceptFailed: true to roll back without the files that failed: they stay as they are now and lose their saved copies",
};

interface Point {
  session: SessionState;
  turnIndex: number;
  /** Questions before it, steers not counted (what the body said). */
  priorQuestions: number;
  text: string;
  at: number;
  body: { files?: unknown; acceptFailed?: unknown; skip?: unknown; expectPlanHash?: unknown; expectTranscriptRev?: unknown };
}

export function createListRewindPointsHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    const id = ctx.params.id ?? "";
    const session = ctx.runtime.sessionStore.load(id);
    if (!session) return notFound(res, id);
    sendJson(res, 200, {
      id,
      points: listRewindPoints(session).map((point) => ({
        turnIndex: point.turnIndex,
        priorQuestions: point.ordinal - 1,
        text: point.text,
        at: point.at,
      })),
    });
  };
}

/** `preview: true` answers what a rollback would do; `false` does it. */
export function createRewindHandler(preview: boolean): HttpHandler {
  return async (req, res, ctx) => {
    const point = await readPoint(req, res, ctx);
    if (point === null) return;
    const { session, turnIndex, text, at } = point;
    const acceptFailed = point.body.acceptFailed;
    if (!preview && acceptFailed !== undefined && typeof acceptFailed !== "boolean") {
      sendError(res, 400, openaiError("acceptFailed must be a boolean", "invalid_request_error", "acceptFailed"));
      return;
    }
    // Issue #80: files the person chose to leave as they are; never read, written or deleted.
    // The preview applies and validates it the same way, so it shows what that rollback would do.
    const skip = point.body.skip ?? [];
    if (!isSkipList(skip)) {
      sendError(res, 400, openaiError(`skip must be an array of at most ${MAX_SKIP} non-empty paths`, "invalid_request_error", "skip"));
      return;
    }
    // Issue #83: the preview's planHash, so a rollback confirmed later
    // refuses if what it would do changed in between.
    const expectPlanHash = point.body.expectPlanHash;
    if (!preview && expectPlanHash !== undefined && !(typeof expectPlanHash === "string" && expectPlanHash.length > 0 && expectPlanHash.length <= 200)) {
      sendError(res, 400, openaiError("expectPlanHash must be a non-empty string of at most 200 characters", "invalid_request_error", "expectPlanHash"));
      return;
    }
    // Issue #87: the transcript the preview showed, so a conversation-only
    // rollback (files: false) can be bound to it too.
    const expectTranscriptRev = point.body.expectTranscriptRev;
    if (!preview && expectTranscriptRev !== undefined && !(typeof expectTranscriptRev === "string" && expectTranscriptRev.length > 0 && expectTranscriptRev.length <= 200)) {
      sendError(res, 400, openaiError("expectTranscriptRev must be a non-empty string of at most 200 characters", "invalid_request_error", "expectTranscriptRev"));
      return;
    }
    const plan = planRewind(session, turnIndex);
    if (!plan.ok) return refuse(res, plan.code);
    const store = checkpointStore(ctx);
    const files = await planFileRestore(store, session.id, at, { skip, cwd: session.workingDir });
    if (files.unknownSkip.length > 0) {
      // `unknownSkip`: the paths exactly as sent, so a client need not parse the message (issue #87).
      sendJson(res, 400, {
        ...openaiError(
          `skip names files with no saved copy since that question: ${files.unknownSkip.join(", ")}`,
          "invalid_request_error",
          "skip",
          "skip_unknown",
        ),
        unknownSkip: files.unknownSkip,
      });
      return;
    }
    const removed = session.turns.slice(turnIndex);
    // The planHash binds the transcript too (issue #87): a turn another
    // client completed since the preview changes it.
    const hashOf = (filePlan: typeof files, chat: SessionState): string =>
      restorePlanHash(filePlan, { priorQuestions: point.priorQuestions, expectText: text, transcriptRev: transcriptRev(chat, turnIndex) });
    if (preview) {
      sendJson(res, 200, {
        id: session.id,
        turnIndex,
        text,
        removed: removedCounts(removed),
        // `error`: the file could not be checked now; the rollback would report it in `failed` (issue #80).
        // `contentUnchecked`: a file not read, fingerprinted by its stat only (issue #87): `contentUncheckedReason` says why.
        files: files.items.map((item) => ({
          path: item.path,
          action: item.action,
          ...(item.blocked !== undefined ? { error: item.blocked } : {}),
          ...(item.contentUnchecked ? { contentUnchecked: true, contentUncheckedReason: item.contentUncheckedReason } : {}),
        })),
        notRestorable: files.notRestorable,
        incomplete: files.incomplete,
        skipped: files.skipped,
        uncovered: uncoveredToolCalls(removed),
        planHash: hashOf(files, session),
        transcriptRev: transcriptRev(session, turnIndex),
      });
      return;
    }
    // `files: false` takes back only the conversation.
    const restoreFiles = point.body.files !== false;
    // Issue #74: the restore and the save run under the chat's turn lock,
    // so a turn sent meanwhile queues behind the rewind instead of being
    // overwritten by it. Checked and queued in one tick: nothing can start
    // between the two.
    if (ctx.runtime.turnController.isBusy(session.id)) return refuse(res, "turn_in_progress");
    // The same point on a reloaded chat: refused when its transcript moved
    // on since the request was checked, or with planRewind's own code.
    const replan = (chat: SessionState): ReturnType<typeof planRewind> =>
      sameTranscript(chat, session) ? planRewind(chat, turnIndex, text) : { ok: false, code: "point_mismatch" };
    let applied = files;
    const outcome = await ctx.runtime.turnController.enqueue({
      sessionId: session.id,
      origin: "http",
      run: async (): Promise<RewindOutcome> => {
        // The chat as it is now. Only its transcript matters: an unrelated
        // write (a next-step suggestion, a title) is no reason to refuse.
        const current = ctx.runtime.sessionStore.load(session.id);
        const before = current === null ? null : replan(current);
        if (current === null || before === null) return { refused: "point_mismatch" };
        if (!before.ok) return { refused: before.code };
        // Planned again under the lock (issue #80): the disk may have
        // changed since the request was checked, a file blocked then (a
        // lock, a permission) may be free now.
        if (restoreFiles || expectPlanHash !== undefined) {
          applied = await planFileRestore(store, session.id, at, { skip, cwd: session.workingDir });
        }
        // Issue #83: not what the preview showed; refused before anything changes.
        if (typeof expectPlanHash === "string" && hashOf(applied, current) !== expectPlanHash) return { refused: "plan_changed" };
        const checkedRev = transcriptRev(current, turnIndex);
        if (typeof expectTranscriptRev === "string" && checkedRev !== expectTranscriptRev) return { refused: "plan_changed" };
        // A compaction started on this chat would summarise the rows removed.
        ctx.runtime.cancelSessionCompaction(session.id);
        const done = restoreFiles
          ? await applyFileRestore(store, session.id, applied)
          : { restored: [], deleted: [], failed: [] };
        // Issue #77: a file that did not go back keeps the point and every
        // copy, so the rollback can be retried; cutting the chat or dropping
        // the copies now would lose the only way back.
        if (done.failed.length > 0 && acceptFailed !== true) return { refused: "restore_failed", done };
        // Planned again from the stored chat right before the save, with no
        // await between: a turn another process started during the restore
        // refuses, and a write that left the transcript alone is kept.
        const latest = ctx.runtime.sessionStore.load(session.id);
        // Rows after the point rewritten meanwhile by another process, the
        // count kept, slip past sameTranscript: compare the whole revision
        // with the one checked above (issue #87).
        if (latest !== null && transcriptRev(latest, turnIndex) !== checkedRev) return { refused: "plan_changed", done };
        const final = latest === null ? null : replan(latest);
        if (final === null || !final.ok) return { refused: final?.code ?? "point_mismatch", done };
        ctx.runtime.sessionStore.save(final.state);
        releasePrivacyVault(session.id);
        ctx.runtime.sessionStore.clearTurnProgress(session.id);
        // The turns those copies belong to are gone.
        await store.dropSince(session.id, at);
        return { done };
      },
    });
    if (outcome.refused !== undefined) {
      if (outcome.done === undefined) return refuse(res, outcome.refused);
      // Files were already put back; the chat was not cut. Say both:
      // unlike every other 409 here, this one changed something.
      sendJson(res, 409, {
        ...openaiError(
          outcome.refused === "restore_failed"
            ? REFUSAL_MESSAGES[outcome.refused]
            : `${REFUSAL_MESSAGES[outcome.refused]} (the chat was not cut, but files were already put back: see restored and deleted)`,
          "invalid_request_error",
          null,
          outcome.refused,
        ),
        partial: true,
        ...outcome.done,
        notRestorable: restoreFiles ? applied.notRestorable : [],
        incomplete: restoreFiles && applied.incomplete,
        skipped: restoreFiles ? applied.skipped : [],
      });
      return;
    }
    sendJson(res, 200, {
      id: session.id,
      text,
      ...outcome.done,
      notRestorable: restoreFiles ? applied.notRestorable : [],
      incomplete: restoreFiles && applied.incomplete,
      skipped: restoreFiles ? applied.skipped : [],
    });
  };
}

const MAX_SKIP = 1000;

function isSkipList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_SKIP && value.every((path) => typeof path === "string" && path.length > 0);
}

/**
 * The transcript a preview showed (issue #87): how many rows the chat
 * has and a sha256 of every row from the point on (kind, text, tool
 * calls, times). Titles and other metadata are not part of it.
 */
function transcriptRev(chat: SessionState, turnIndex: number): string {
  return sha256Of(Buffer.from(JSON.stringify({ rows: chat.turns.length, after: chat.turns.slice(turnIndex) }), "utf8"));
}

/** Same rows as when the request was checked (a turn appends rows, a compaction or rollback removes some). */
function sameTranscript(a: SessionState, b: SessionState): boolean {
  return a.turns.length === b.turns.length && a.turns.at(-1)?.at === b.turns.at(-1)?.at && a.turns.at(-1)?.kind === b.turns.at(-1)?.kind;
}

type RestoreDone = Awaited<ReturnType<typeof applyFileRestore>>;
type RewindOutcome =
  | { refused?: undefined; done: RestoreDone }
  | { refused: RewindRefusal | "restore_failed" | "plan_changed"; done?: RestoreDone };

export function createForkSessionHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const point = await readPoint(req, res, ctx);
    if (point === null) return;
    const plan = planFork(point.session, {
      priorQuestions: point.priorQuestions,
      expectText: point.text,
    });
    if (!plan.ok) return refuse(res, plan.code);
    ctx.runtime.sessionStore.save(plan.state);
    sendJson(res, 200, { id: plan.state.id, title: plan.title, sourceId: point.session.id });
  };
}

/**
 * The session and the question the body names, or null once an error
 * was sent. Refuses while a turn runs on the chat (this process's, or
 * one another process on the state dir marked).
 */
async function readPoint(
  req: Parameters<HttpHandler>[0],
  res: ServerResponse,
  ctx: HandlerContext,
): Promise<Point | null> {
  const id = ctx.params.id ?? "";
  let body: { priorQuestions?: unknown; expectText?: unknown; files?: unknown; acceptFailed?: unknown; skip?: unknown; expectPlanHash?: unknown; expectTranscriptRev?: unknown } | null;
  try {
    body = (await readJsonBody<unknown>(req)) as typeof body;
  } catch (err) {
    sendError(res, 400, openaiError(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`));
    return null;
  }
  const prior = body?.priorQuestions;
  if (typeof prior !== "number" || !Number.isInteger(prior) || prior < 0) {
    sendError(res, 400, openaiError("priorQuestions must be a non-negative integer", "invalid_request_error", "priorQuestions"));
    return null;
  }
  const expectText = body?.expectText;
  if (typeof expectText !== "string") {
    sendError(res, 400, openaiError("expectText must be a string", "invalid_request_error", "expectText"));
    return null;
  }
  const session = ctx.runtime.sessionStore.load(id);
  if (!session) {
    notFound(res, id);
    return null;
  }
  if (ctx.runtime.turnController.isBusy(id)) {
    refuse(res, "turn_in_progress");
    return null;
  }
  const turnIndex = questionRowIndex(session, prior);
  const row = turnIndex < 0 ? undefined : session.turns[turnIndex];
  if (row === undefined || row.kind !== "user" || row.text.trim() !== expectText.trim()) {
    refuse(res, "point_mismatch");
    return null;
  }
  return { session, turnIndex, priorQuestions: prior, text: row.text, at: row.at, body: body ?? {} };
}

function removedCounts(rows: readonly ConversationTurn[]): { questions: number; replies: number } {
  let questions = 0;
  let replies = 0;
  for (const row of rows) {
    if (row.kind === "user" && row.steered !== true) questions += 1;
    if (row.kind === "assistant_reply" && row.progressNote !== true && row.stopped !== true) replies += 1;
  }
  return { questions, replies };
}

function checkpointStore(ctx: HandlerContext): FileCheckpointStore {
  return new FileCheckpointStore(fileCheckpointsRoot(ctx.runtime.config.paths.stateDir));
}

function refuse(res: ServerResponse, code: Refusal): void {
  sendError(res, 409, openaiError(REFUSAL_MESSAGES[code], "invalid_request_error", null, code));
}

function notFound(res: ServerResponse, id: string): void {
  sendError(res, 404, openaiError(`session not found: ${id}`, "invalid_request_error", null, "session_not_found"));
}
