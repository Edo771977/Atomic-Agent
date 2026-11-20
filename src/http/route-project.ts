import { projectContinueMessage } from "../session/project-continue.js";
import { parseProjectDecision } from "../session/project-decision-parse.js";
import { openaiError } from "./openai-errors.js";
import { readJsonBody, sendError, sendJson, type HttpHandler } from "./request-context.js";
import { SERVE_RESTRICTED_CODE, SERVE_RESTRICTED_NOTICE, serveWithheld } from "./serve-egress.js";

/**
 * The fusion project gate over HTTP (issue #39): `GET /api/project?session=<id>`
 * returns the view the cards draw, `POST /api/project/decision` takes the
 * person's verdict. The view is the runtime's (`AgentRuntime.projectState`);
 * the decision goes through `AgentRuntime.projectDecision`, which owns
 * every rule (between turns, the current gate, the version, hard caps).
 * Gate changes reach `GET /api/events` as `project_gate` events.
 */

interface DecisionBody {
  session?: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The HTTP status for a refusal code from `projectDecision`. */
function statusFor(code: string): number {
  switch (code) {
    case "no-project":
    case "no-session":
      return 404;
    case "stale-version":
    case "wrong-gate":
    case "turn-running":
    // A required task has no current reviewer accept (issue #98): the state, not the request, is the problem.
    case "review-open":
      return 409;
    case "over-cap":
    case "needs-estimates":
      return 422;
    default:
      return 400;
  }
}

function sendWithheld(res: Parameters<HttpHandler>[1]): void {
  sendError(res, 403, openaiError(SERVE_RESTRICTED_NOTICE, "permission_error", null, SERVE_RESTRICTED_CODE));
}

export function createGetProjectHandler(): HttpHandler {
  return (req, res, ctx) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const sessionId = url.searchParams.get("session");
    if (sessionId === null || sessionId.length === 0) {
      sendError(res, 400, openaiError("?session=<id> is required"));
      return;
    }
    if (serveWithheld(ctx, sessionId)()) {
      sendWithheld(res);
      return;
    }
    const view = ctx.runtime.projectState?.(sessionId) ?? null;
    if (view === null) {
      sendError(res, 404, openaiError(`no project on session ${sessionId}`));
      return;
    }
    sendJson(res, 200, { session_id: sessionId, view });
  };
}

export function createProjectDecisionHandler(): HttpHandler {
  return async (req, res, ctx) => {
    let body: DecisionBody & Record<string, unknown>;
    try {
      body = await readJsonBody<DecisionBody & Record<string, unknown>>(req);
    } catch (err) {
      sendError(res, 400, openaiError(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    if (!isObject(body)) {
      sendError(res, 400, openaiError("body must be a JSON object"));
      return;
    }
    const sessionId = body.session;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      sendError(res, 400, openaiError("session is required"));
      return;
    }
    const decision = parseProjectDecision(body);
    if (typeof decision === "string") {
      sendError(res, 400, openaiError(decision));
      return;
    }
    if (serveWithheld(ctx, sessionId)()) {
      sendWithheld(res);
      return;
    }
    const decide = ctx.runtime.projectDecision;
    if (decide === undefined) {
      sendError(res, 501, openaiError("this agent takes no project decisions"));
      return;
    }
    if ((ctx.runtime.projectState?.(sessionId) ?? null) === null) {
      sendError(res, 404, openaiError(`no project on session ${sessionId}`));
      return;
    }
    const outcome = decide.call(ctx.runtime, sessionId, decision);
    if (outcome.ok) {
      // The runtime itself emits `project_gate` for the decision; serve
      // relays its events to the bus, so the route does not publish again.
      // What the client sends as the next message when the decision closed
      // the gate on director work (null: nothing to run).
      sendJson(res, 200, { session_id: sessionId, view: outcome.view, continue_message: projectContinueMessage(outcome.view, decision) });
      return;
    }
    const current = ctx.runtime.projectState?.(sessionId) ?? null;
    sendJson(res, statusFor(outcome.error.code), {
      error: { message: outcome.error.message, type: "invalid_request_error", code: outcome.error.code },
      ...(current === null ? {} : { view: current }),
    });
  };
}
