import {
  canGrantShape,
  type ApprovalGate,
  type ApprovalRequest,
} from "../approval/approval-gate.js";
import { approvalForServe, isNamedCaller, sessionUnavailableToCaller, serveWithheld } from "./serve-egress.js";
import type { ProjectGateEvent } from "./project-gate-bus.js";
import { describeAlwaysRule } from "../approval/approval-rules.js";

import { openaiError } from "./openai-errors.js";
import {
  beginSse,
  readJsonBody,
  sendError,
  sendJson,
  SSE_HEARTBEAT_MS,
  type HttpHandler,
} from "./request-context.js";

interface ResolveBody {
  approvalId?: string;
  decision?: string;
  /** On a deny, the user's own words; the model reads it as what they said. */
  reason?: string;
}

/**
 * The decisions `POST /api/approval/resolve` accepts, advertised on
 * `GET /api/capabilities` (`agent.approvalDecisions`) so a client draws
 * only the answers this agent understands. `approve` / `reject` are
 * accepted aliases of `allow-once` / `deny` and are not listed.
 */
export const APPROVAL_DECISIONS = [
  "allow-once",
  "allow-in-chat",
  "allow-always",
  "deny",
] as const;

type ParsedDecision = {
  approved: boolean;
  /** `shape` for allow-in-chat, `always` for allow-always. */
  grant?: "shape" | "always";
};

/**
 * What `GET /api/events` sends for a request: the request itself plus
 * whether "Allow always" may be offered for it (`canAlways`) and the text
 * that choice shows (`alwaysLabel`, `Always allow "git status" in this
 * project`). A client draws the button only when `canAlways` is true.
 */
export function approvalEventPayload(
  request: ApprovalRequest,
  gate: Pick<ApprovalGate, "canGrantAlways">,
): ApprovalRequest & { canAlways: boolean; alwaysLabel?: string } {
  const canAlways = gate.canGrantAlways(request);
  return {
    ...request,
    reason: [
      request.reason,
      ...(request.requestedByToken ? [`richiesto dal token ${request.requestedByToken}`] : []),
      ...((request.steeredByTokens ?? []).map(name => `steer dal token ${name}`)),
    ].join(" · "),
    canAlways,
    ...(canAlways ? { alwaysLabel: describeAlwaysRule(request) } : {}),
  };
}

/**
 * `POST /api/approval/resolve` — resolve a pending approval emitted
 * by a dangerous tool. Accepts the hermes-style `allow-once` / `deny`
 * vocabulary plus the shorter `approve` / `reject` aliases, and
 * `allow-in-chat`: approve, and stop asking about this command for the
 * rest of the chat. That is the gate's shape grant (the TUI's `[a]`),
 * scoped to the request's own session and its `commandShape` (the
 * binary, `git`), never to the whole category. A request without a
 * shape (not a shell call, or an opaque `bash -c …` the shell tool
 * withholds it for) cannot take it: the route answers 400 and the
 * request stays pending, so a click never turns into a wider or a
 * narrower yes than the one the person chose.
 *
 * `allow-always` approves and saves an allow rule in the approval rules
 * file (ATO-1142), built by the gate from its own pending request and
 * scoped to the session's project; later matching calls in that project
 * run unasked in any chat. Only where `canGrantAlways` holds (a grantable
 * category, a known project, a shell command the agent can name): else
 * `400` and the request stays pending. The response carries the `rule`.
 */
export function createResolveApprovalHandler(): HttpHandler {
  return async (req, res, ctx) => {
    let body: ResolveBody;
    try {
      body = await readJsonBody<ResolveBody>(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 400, openaiError(`Invalid JSON: ${message}`));
      return;
    }
    const approvalId = body.approvalId;
    const rawDecision = body.decision;
    if (!approvalId || typeof approvalId !== "string") {
      sendError(res, 400, openaiError("approvalId is required"));
      return;
    }
    const parsed = parseDecision(rawDecision);
    if (parsed === null) {
      sendError(
        res,
        400,
        openaiError(
          "decision must be one of allow-once|allow-in-chat|allow-always|deny|approve|reject",
        ),
      );
      return;
    }
    const { approved, grant } = parsed;
    const pending = ctx.runtime.approvals.pendingRequest(approvalId);
    if (isNamedCaller(ctx) && (pending === null || sessionUnavailableToCaller(ctx, pending.sessionId))) {
      if (pending === null) ctx.approvalBus.resolved(approvalId);
      return sendError(res, 404, openaiError("approvalId not pending"));
    }
    const role = ctx.caller?.role;
    if (approved && role === "operator" && (grant === "always" || pending?.category === "trust_config")) {
      sendError(res, 403, openaiError(
        "This approval requires the admin scope",
        "permission_error",
        null,
        "insufficient_scope",
      ));
      return;
    }
    if (approved) {
      // An `ask_user` question (ATO-489) is answered with a choice, not an
      // Allow: a bare approve would reach the model as no answer at all.
      if (pending?.category === "user_question") {
        sendError(
          res,
          400,
          openaiError("this is a question; answer it with POST /api/question/answer"),
        );
        return;
      }
    }
    const inChat = grant === "shape";
    if (grant === "always") {
      const request = ctx.runtime.approvals.pendingRequest(approvalId);
      if (request !== null && !ctx.runtime.approvals.canGrantAlways(request)) {
        sendError(
          res,
          400,
          openaiError(
            "allow-always is not offered for this request; answer allow-once or deny",
          ),
        );
        return;
      }
    }
    if (inChat) {
      const request = ctx.runtime.approvals.pendingRequest(approvalId);
      if (request !== null && !canGrantShape(request)) {
        sendError(
          res,
          400,
          openaiError(
            "allow-in-chat needs a shell command the agent can name; answer allow-once or deny",
          ),
        );
        return;
      }
    }
    const resolved = ctx.runtime.approvals.resolve({
      approvalId,
      approved,
      ...(grant !== undefined ? { grant } : {}),
      ...(body.reason ? { reason: body.reason } : {}),
    });
    if (!resolved) {
      // Not pending at the gate (its turn was aborted): not pending here either.
      ctx.approvalBus.resolved(approvalId);
      sendError(res, 404, openaiError(`approvalId not pending: ${approvalId}`));
      return;
    }
    ctx.approvalBus.resolved(approvalId);
    const rule =
      grant === "always" ? ctx.runtime.approvals.takeAlwaysRule(approvalId) : null;
    sendJson(res, 200, {
      resolved: true,
      approvalId,
      approved,
      ...(inChat ? { grant: "chat" } : {}),
      ...(grant === "always" ? { grant: "always", rule } : {}),
    });
  };
}

function parseDecision(raw: unknown): ParsedDecision | null {
  if (typeof raw !== "string") return null;
  const normalised = raw.trim().toLowerCase();
  if (normalised === "allow-once" || normalised === "approve")
    return { approved: true };
  if (normalised === "allow-in-chat") return { approved: true, grant: "shape" };
  if (normalised === "allow-always") return { approved: true, grant: "always" };
  if (normalised === "deny" || normalised === "reject")
    return { approved: false };
  return null;
}

/**
 * `GET /api/events` — SSE stream of approval requests. Replays
 * already-pending requests on connect so late subscribers never miss
 * a prompt, then keeps the connection open for fresh emissions.
 *
 * Only requests the gate still holds are replayed: one whose turn was
 * aborted is gone from the gate but was still in the bus. The stream
 * also carries a comment line now and then, so a client's idle timeout
 * (undici: 300 s) does not drop it and replay on every reconnect.
 */
export function createApprovalEventsHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    const sse = beginSse(res, {}, { heartbeatMs: SSE_HEARTBEAT_MS, ...(ctx.stillAuthorized ? { stillAuthorized: ctx.stillAuthorized } : {}) });
    res.flushHeaders();
    ctx.approvalBus.prune((request) =>
      ctx.runtime.approvals.isPending(request.approvalId),
    );
    const authorized = (): boolean => {
      if (ctx.stillAuthorized?.() !== false) return true;
      res.end();
      return false;
    };
    const writeApproval = (request: ApprovalRequest): void => {
      if (!authorized()) return;
      const visible = approvalForServe(ctx, request);
      if (visible) sse.writeEvent("approval_request", approvalEventPayload(visible, ctx.runtime.approvals));
    };
    for (const pending of ctx.approvalBus.snapshot()) writeApproval(pending);
    const unsubscribe = ctx.approvalBus.subscribe(writeApproval);
    // Issue #39: fusion project gates, the open ones replayed so a
    // reloaded window draws its card again. A session whose content may
    // not leave over this server gets no frame.
    const writeGate = (event: ProjectGateEvent): void => {
      if (!authorized() || serveWithheld(ctx, event.sessionId)()) return;
      if (sessionUnavailableToCaller(ctx, event.sessionId)) return;
      sse.writeEvent("project_gate", { session_id: event.sessionId, view: event.view });
    };
    for (const event of ctx.projectGateBus?.snapshot() ?? []) writeGate(event);
    const onMemoryChange = () => sse.writeEvent("memory_state_changed", {});
    ctx.memoryEvents?.on("state", onMemoryChange);
    const unsubscribeGates = ctx.projectGateBus?.subscribe(writeGate);
    await new Promise<void>((resolvePromise) => {
      res.once("close", () => {
        unsubscribe();
        unsubscribeGates?.();
        ctx.memoryEvents?.off("state", onMemoryChange);
        sse.close();
        resolvePromise();
      });
    });
  };
}
