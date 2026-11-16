import type { ProjectGateDecision } from "../session/project-gate-view.js";
import type { ProjectEdits, ProjectGate, ProjectVerdict } from "../session/session-project.js";
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

const VERDICTS: readonly ProjectVerdict[] = ["approve", "edit", "cheaper", "quality", "cancel"];
const MAX_NOTE_CHARS = 2000;

interface DecisionBody {
  session?: unknown;
  gate?: unknown;
  version?: unknown;
  verdict?: unknown;
  edits?: unknown;
  note?: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function parseGate(raw: unknown): ProjectGate | null {
  if (!isObject(raw)) return null;
  switch (raw.kind) {
    case "none":
    case "brief":
    case "plan":
      return { kind: raw.kind };
    case "milestone":
      return typeof raw.id === "string" && raw.id.length > 0 ? { kind: "milestone", id: raw.id } : null;
    default:
      return null;
  }
}

function parseEdits(raw: unknown): ProjectEdits | string {
  if (!isObject(raw)) return "edits must be an object";
  const out: ProjectEdits = {};
  if (raw.rows !== undefined) {
    if (!Array.isArray(raw.rows)) return "edits.rows must be an array";
    const rows: Array<{ taskId: string; worker?: string; reviewer?: string | null }> = [];
    for (const row of raw.rows) {
      if (!isObject(row) || typeof row.taskId !== "string") return "each edits.rows entry needs a taskId";
      if (row.worker !== undefined && typeof row.worker !== "string") return "edits.rows[].worker must be a string";
      if (row.reviewer !== undefined && row.reviewer !== null && typeof row.reviewer !== "string") {
        return "edits.rows[].reviewer must be a string or null";
      }
      rows.push({
        taskId: row.taskId,
        ...(typeof row.worker === "string" ? { worker: row.worker } : {}),
        ...(row.reviewer !== undefined ? { reviewer: row.reviewer as string | null } : {}),
      });
    }
    out.rows = rows;
  }
  if (raw.brief !== undefined) {
    if (!isObject(raw.brief)) return "edits.brief must be an object";
    const brief: Record<string, unknown> = {};
    for (const key of ["what", "users", "how"] as const) {
      const v = raw.brief[key];
      if (v === undefined) continue;
      if (typeof v !== "string") return `edits.brief.${key} must be a string`;
      brief[key] = v;
    }
    if (raw.brief.successCriteria !== undefined) {
      const c = raw.brief.successCriteria;
      if (!Array.isArray(c) || !c.every((x) => typeof x === "string")) return "edits.brief.successCriteria must be strings";
      brief.successCriteria = c;
    }
    out.brief = brief as ProjectEdits["brief"];
  }
  return out;
}

/** The HTTP status for a refusal code from `projectDecision`. */
function statusFor(code: string): number {
  switch (code) {
    case "no-project":
      return 404;
    case "stale-version":
    case "wrong-gate":
    case "busy":
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
    const view = ctx.runtime.projectState?.(sessionId);
    if (view === undefined) {
      sendError(res, 404, openaiError(`no project on session ${sessionId}`));
      return;
    }
    sendJson(res, 200, { session_id: sessionId, view });
  };
}

export function createProjectDecisionHandler(): HttpHandler {
  return async (req, res, ctx) => {
    let body: DecisionBody;
    try {
      body = await readJsonBody<DecisionBody>(req);
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
    const gate = parseGate(body.gate);
    if (gate === null) {
      sendError(res, 400, openaiError('gate must be {kind: "brief"|"plan"|"none"} or {kind: "milestone", id}'));
      return;
    }
    if (!Number.isInteger(body.version) || (body.version as number) < 1) {
      sendError(res, 400, openaiError("version must be a positive integer (the view's version)"));
      return;
    }
    if (typeof body.verdict !== "string" || !(VERDICTS as readonly string[]).includes(body.verdict)) {
      sendError(res, 400, openaiError(`verdict must be one of ${VERDICTS.join(", ")}`));
      return;
    }
    const decision: ProjectGateDecision = { gate, version: body.version as number, verdict: body.verdict as ProjectVerdict };
    if (body.edits !== undefined) {
      const edits = parseEdits(body.edits);
      if (typeof edits === "string") {
        sendError(res, 400, openaiError(edits));
        return;
      }
      decision.edits = edits;
    }
    if (body.note !== undefined) {
      if (typeof body.note !== "string" || body.note.trim().length === 0 || body.note.length > MAX_NOTE_CHARS) {
        sendError(res, 400, openaiError(`note must be a non-empty string of at most ${MAX_NOTE_CHARS} characters`));
        return;
      }
      decision.note = body.note;
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
    if (ctx.runtime.projectState?.(sessionId) === undefined) {
      sendError(res, 404, openaiError(`no project on session ${sessionId}`));
      return;
    }
    const outcome = await decide.call(ctx.runtime, sessionId, decision);
    if (outcome.ok) {
      ctx.projectGateBus?.publish({ type: "project_gate", sessionId, view: outcome.view });
      sendJson(res, 200, { session_id: sessionId, view: outcome.view });
      return;
    }
    const current = ctx.runtime.projectState?.(sessionId);
    sendJson(res, statusFor(outcome.error.code), {
      error: { message: outcome.error.message, type: "invalid_request_error", code: outcome.error.code },
      ...(current === undefined ? {} : { view: current }),
    });
  };
}
