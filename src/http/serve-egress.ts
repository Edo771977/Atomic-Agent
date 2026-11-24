import { isIncognitoSession } from "../session/incognito.js";
import type { SessionState } from "../session/session-state.js";
import type { ApprovalRequest } from "../approval/approval-gate.js";
import { getConfig } from "../config/index.js";
import { hasProjectConstraints } from "../llm/provider-policy.js";
import { withholdApprovalDetails } from "../approval/approval-details-withheld.js";
import { isLoopbackHostname } from "./loopback-guard.js";
import type { HandlerContext } from "./request-context.js";

/**
 * Per-folder egress for `serve` on a network address (issue #33). On a
 * loopback host the HTTP API stays on this machine; on any other
 * (`--host 0.0.0.0`, a LAN address) every reply, transcript and
 * approval preview goes to another machine. A session whose folder, or
 * read taint, does not list "serve" in `allowedEgress` is then refused:
 * its chat turns (before the turn, and as soon as a mid-turn read taints
 * it), its `/api/sessions/{id}/…` routes, and its approval details on
 * `/api/events`. A loopback server is unchanged. Records that carry a
 * session's content outside its own routes follow the same rule (issue
 * #74): tasks (`/api/tasks*`), ideas and the `GET /api/sessions` row.
 */

/** The text a refused request gets: fixed, so nothing of the session leaves. */
export const SERVE_RESTRICTED_NOTICE =
  'This folder is restricted: this server listens on a network address and "serve" is not in the folder\'s allowedEgress. Open atomic-agent on the computer.';

export const SERVE_RESTRICTED_CODE = "folder_restricted";

/**
 * Whether `serve` listening on `host` reaches other machines. Only a
 * loopback name or address stays on this one; the machine's own host
 * name resolves to a network address, so it counts as network.
 */
export function isNetworkListenHost(host: string): boolean {
  const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return !isLoopbackHostname(bracketed, "");
}

/**
 * `() => true` while the session's content may not go out over this
 * server. Always false on a loopback server or without the runtime
 * check; a throwing check refuses (fail closed).
 */
export function serveWithheld(
  ctx: Pick<HandlerContext, "networkServe" | "runtime">,
  session: string | { id: string; workingDir: string; metadata?: Record<string, unknown> },
): () => boolean {
  return () => {
    if (ctx.networkServe !== true) return false;
    const check = ctx.runtime.serveRefusal;
    if (check === undefined) return false;
    try {
      return check(session) !== null;
    } catch {
      return true;
    }
  };
}

/** Named tokens can read only ordinary chats exposed by this listener. */
export function canReadSession(ctx: HandlerContext, state: SessionState | null): state is SessionState {
  return state !== null && (ctx.caller === undefined || ctx.caller.role === "owner"
    || (!isIncognitoSession(state) && !serveWithheld(ctx, state)()));
}

/** An approval prompt as a network server may show it: no details for a restricted session. */
export function approvalForServe(
  ctx: HandlerContext,
  request: ApprovalRequest,
): ApprovalRequest | undefined {
  if (ctx.caller !== undefined && ctx.caller.role !== "owner"
    && !canReadSession(ctx, ctx.runtime.sessionStore.load(request.sessionId))) return undefined;
  return serveWithheld(ctx, request.sessionId)() ? withholdApprovalDetails(request) : request;
}

/**
 * Whether a record bound to `sessionId` (a task, an idea) is withheld on
 * this server (issue #74). A record with no session runs where the
 * server works, so it is judged by the policy of the server's own folder
 * (`capabilities.workingDir`): withheld only when that folder lacks
 * "serve". A failing check refuses (fail closed).
 */
export function serveWithheldRecord(
  ctx: Pick<HandlerContext, "networkServe" | "runtime">,
  sessionId: string | null,
): boolean {
  if (sessionId !== null) return serveWithheld(ctx, sessionId)();
  if (ctx.networkServe !== true || ctx.runtime.serveRefusal === undefined) return false;
  try {
    if (!hasProjectConstraints(getConfig())) return false;
    return serveWithheld(ctx, { id: "", workingDir: ctx.runtime.capabilities.workingDir })();
  } catch {
    return true;
  }
}
