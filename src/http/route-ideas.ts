import { getConfig } from "../config/index.js";
import { hasProjectConstraints } from "../llm/provider-policy.js";
import { RETRY_RESTRICTION_UNKNOWN, retrySourceOf, type RetrySource } from "../runtime/session-provider-policy.js";
import { openaiError } from "./openai-errors.js";
import {
  readJsonBody,
  sendError,
  sendJson,
  type HttpHandler,
  type HandlerContext,
} from "./request-context.js";
import { existingSessionUnavailableToCaller, serveWithheldRecord, taskUnavailableToCaller } from "./serve-egress.js";
import { checkWorkingDir } from "./session-working-dir.js";
import {
  IDEA_STATUSES,
  IdeaStateError,
  IdeaStore,
  IdeaUnavailableError,
  TaskValidationError,
  acceptIdea,
  ideaRetryFallbackDir,
  ideaToJson,
  refreshIdeas,
  type IdeaRecord,
  type IdeaStatus,
} from "../tasks/index.js";

/**
 * Proactive suggestions over HTTP (ATO-458), for the desktop's cards:
 *
 *  - `GET  /api/ideas[?status=new,accepted&limit=N]` lists them, newest first.
 *  - `POST /api/ideas/refresh` rebuilds the undecided ones from the local
 *    task queue and chat goals, and answers `{ ideas, added, retired }`
 *    with `ideas` the `new` ones.
 *  - `POST /api/ideas/{id}/accept` with optional `{ prompt }` (the edited
 *    text) files the task the way `POST /api/tasks` does and answers
 *    `{ idea, task }`; `409 idea_decided` when the card was already
 *    accepted or dismissed. A Retry card's task keeps the original's
 *    `maxSteps`, `maxCostUsd`, `maxDurationMs` and `notify`, and runs in
 *    a new chat opened in the original chat's folder that keeps the
 *    original chat's provider restriction (issue #68); when that folder
 *    is gone, a restricted retry opens in the home folder and an
 *    unrestricted one runs where the task runner works. `400` (param
 *    `sessionId`, card retired) when the original chat is gone with no
 *    policy recorded while constraints exist.
 *  - `POST /api/ideas/{id}/dismiss` retires the card for good.
 *
 * All four answer 404 when `tasks.enabled` is false. The store is opened
 * on `tasks.sqlite` per request and closed after it: the routes are
 * called a few times a day, and the runtime contract stays unchanged.
 */
function withIdeaStore(
  ctx: HandlerContext,
  fn: (ideas: IdeaStore) => void,
): void {
  const ideas = new IdeaStore({ dbFile: ctx.runtime.config.paths.tasksDbFile });
  try {
    fn(ideas);
  } finally {
    ideas.close();
  }
}

/**
 * Issue #33: on a network server an idea built from a restricted
 * session (a goal's criteria, a failed task's message) is not shown,
 * accepted or dismissed: it reads as unknown. An idea with no session is
 * judged by the server folder's policy (issue #74, `serveWithheldRecord`).
 */
function ideaWithheld(ctx: HandlerContext, idea: IdeaRecord): boolean {
  const task = idea.evidence.source === "goal" ? null : ctx.runtime.taskStore.get(idea.evidence.ref);
  if (task && taskUnavailableToCaller(ctx, task)) return true;
  const sessionId = idea.evidence.source === "goal" ? idea.evidence.ref : task?.sessionId ?? idea.sourceSessionId ?? idea.sessionId;
  return (sessionId !== null && existingSessionUnavailableToCaller(ctx, sessionId)) || serveWithheldRecord(ctx, sessionId);
}

/** The runtime's seed (its live view of the original chat); without one, refused while constraints exist. */
function ideaRetrySeed(ctx: HandlerContext, source: RetrySource, workingDir: string) {
  const seed = ctx.runtime.retrySessionSeed;
  if (seed !== undefined) return seed(source, workingDir);
  return hasProjectConstraints(getConfig())
    ? { ok: false as const, error: RETRY_RESTRICTION_UNKNOWN }
    : { ok: true as const, metadata: {}, restricted: false };
}

function visibleIdeas(ctx: HandlerContext, list: IdeaRecord[]): IdeaRecord[] {
  return list.filter((idea) => !ideaWithheld(ctx, idea));
}

function tasksDisabled(ctx: HandlerContext): boolean {
  return !ctx.runtime.config.tasks.enabled;
}

export function createListIdeasHandler(): HttpHandler {
  return async (req, res, ctx) => {
    if (tasksDisabled(ctx)) {
      sendError(res, 404, openaiError("tasks subsystem disabled"));
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const status = parseStatusParam(url.searchParams.get("status"));
    if (status === "invalid") {
      sendError(res, 400, openaiError("unknown idea status", "invalid_request_error", "status"));
      return;
    }
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw === null ? 50 : Number.parseInt(limitRaw, 10);
    if (!Number.isFinite(limit) || limit <= 0) {
      sendError(res, 400, openaiError("limit must be a positive integer", "invalid_request_error", "limit"));
      return;
    }
    withIdeaStore(ctx, (ideas) => {
      const list = ideas.list({ ...(status ? { status } : {}), limit });
      sendJson(res, 200, { ideas: visibleIdeas(ctx, list).map(ideaToJson) });
    });
  };
}

export function createRefreshIdeasHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    if (tasksDisabled(ctx)) {
      sendError(res, 404, openaiError("tasks subsystem disabled"));
      return;
    }
    withIdeaStore(ctx, (ideas) => {
      const result = refreshIdeas({
        ideas,
        tasks: ctx.runtime.taskStore,
        sessions: ctx.runtime.sessionStore,
        ...(ctx.runtime.sessionPolicyStamp ? { sourcePolicy: ctx.runtime.sessionPolicyStamp } : {}),
      });
      sendJson(res, 200, {
        ideas: visibleIdeas(ctx, ideas.list({ status: "new" })).map(ideaToJson),
        added: visibleIdeas(ctx, result.added).map((i) => i.id),
        retired: result.retired,
      });
    });
  };
}

export function createAcceptIdeaHandler(): HttpHandler {
  return async (req, res, ctx) => {
    if (tasksDisabled(ctx)) {
      sendError(res, 404, openaiError("tasks subsystem disabled"));
      return;
    }
    const id = ctx.params.id;
    if (!id) {
      sendError(res, 400, openaiError("idea id is required"));
      return;
    }
    let body: Record<string, unknown> = {};
    try {
      body = (await readJsonBody<Record<string, unknown>>(req)) ?? {};
    } catch (err) {
      sendError(res, 400, openaiError(err instanceof Error ? err.message : "invalid body"));
      return;
    }
    if (body.prompt !== undefined && typeof body.prompt !== "string") {
      sendError(res, 400, openaiError("prompt must be a string", "invalid_request_error", "prompt"));
      return;
    }
    const prompt = typeof body.prompt === "string" ? body.prompt : undefined;
    withIdeaStore(ctx, (ideas) => {
      const known = ideas.get(id);
      if (known !== null && ideaWithheld(ctx, known)) {
        sendError(res, 404, openaiError(`idea not found: ${id}`));
        return;
      }
      try {
        const accepted = acceptIdea(
          ideas,
          ({ sessionId, userMessage, carry, retry, recordedPolicy }) => {
            // A Retry card reruns in a fresh chat opened in the original's folder,
            // the way `POST /api/tasks` with `workingDir` does; a folder that is
            // gone falls back to the home folder when a restriction must be
            // carried (issue #68), else to the task runner's folder.
            let taskSessionId = sessionId;
            let opened: string | null = null;
            const source = taskSessionId ? null : retrySourceOf(retry, carry, recordedPolicy);
            if (source !== null) {
              const dir = carry?.workingDir ? checkWorkingDir(carry.workingDir) : null;
              const target = dir?.ok ? dir.dir : ideaRetryFallbackDir();
              const seed = ideaRetrySeed(ctx, source, target);
              if (!seed.ok) throw new IdeaUnavailableError(`${seed.error}; the card is retired`);
              if (dir?.ok || seed.restricted) {
                const fresh = ctx.runtime.createSession({ metadata: { source: "http-task", ...seed.metadata }, persist: false });
                ctx.runtime.sessionStore.save({ ...fresh, workingDir: target });
                taskSessionId = fresh.id;
                opened = fresh.id;
              }
            }
            try {
              return ctx.runtime.taskRunner.create({
                ...(taskSessionId ? { sessionId: taskSessionId } : {}),
                userMessage,
                origin: "http",
                triggerSource: "user",
                maxAttempts: ctx.runtime.config.tasks.maxAttempts,
                ...(carry
                  ? {
                      maxSteps: carry.maxSteps,
                      maxCostUsd: carry.maxCostUsd,
                      maxDurationMs: carry.maxDurationMs,
                      ...(carry.notify ? { notify: carry.notify } : {}),
                    }
                  : {}),
              });
            } catch (err) {
              if (opened) ctx.runtime.sessionStore.delete(opened);
              throw err;
            }
          },
          id,
          {
            ...(prompt === undefined ? {} : { prompt }),
            carryFrom: { tasks: ctx.runtime.taskStore, sessions: ctx.runtime.sessionStore },
          },
        );
        if (accepted === null) {
          sendError(res, 404, openaiError(`idea not found: ${id}`));
          return;
        }
        sendJson(res, 200, {
          idea: ideaToJson(accepted.idea),
          task: {
            id: accepted.task.id,
            status: accepted.task.status,
            sessionId: accepted.task.sessionId,
          },
        });
      } catch (err) {
        if (!sendDecisionError(res, err)) throw err;
      }
    });
  };
}

export function createDismissIdeaHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    if (tasksDisabled(ctx)) {
      sendError(res, 404, openaiError("tasks subsystem disabled"));
      return;
    }
    const id = ctx.params.id;
    if (!id) {
      sendError(res, 400, openaiError("idea id is required"));
      return;
    }
    withIdeaStore(ctx, (ideas) => {
      const known = ideas.get(id);
      if (known !== null && ideaWithheld(ctx, known)) {
        sendError(res, 404, openaiError(`idea not found: ${id}`));
        return;
      }
      try {
        const dismissed = ideas.dismiss(id);
        if (dismissed === null) {
          sendError(res, 404, openaiError(`idea not found: ${id}`));
          return;
        }
        sendJson(res, 200, { idea: ideaToJson(dismissed) });
      } catch (err) {
        if (!sendDecisionError(res, err)) throw err;
      }
    });
  };
}

function sendDecisionError(res: Parameters<HttpHandler>[1], err: unknown): boolean {
  if (err instanceof IdeaStateError) {
    sendError(res, 409, openaiError(err.message, "invalid_request_error", "status", "idea_decided"));
    return true;
  }
  if (err instanceof TaskValidationError) {
    const param = err.field === "userMessage" ? "prompt" : err.field;
    sendError(res, 400, openaiError(err.message, "invalid_request_error", param));
    return true;
  }
  return false;
}

function parseStatusParam(raw: string | null): IdeaStatus[] | undefined | "invalid" {
  if (raw === null || raw === "") return undefined;
  const parts = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  for (const part of parts) {
    if (!IDEA_STATUSES.includes(part as IdeaStatus)) return "invalid";
  }
  return parts as IdeaStatus[];
}
