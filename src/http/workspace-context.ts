import { sessionUnavailableToCaller } from "./serve-egress.js";
import type { IncomingMessage } from "node:http";
import type { HandlerContext } from "./request-context.js";
import { SessionNotFoundError } from "../runtime/session-not-found-error.js";

/** Explicit workspace preview keeps context-free API calls backward compatible.
 * A new chat is an unsaved session in the server's boot directory, not a
 * renderer-supplied path and not a persisted empty conversation. */
export function requestWorkspace(req: IncomingMessage, ctx: HandlerContext) {
  const { runtime } = ctx;
  const query = new URL(req.url ?? "/", "http://localhost").searchParams;
  const sessionId = query.get("sessionId");
  if (sessionId) {
    if (sessionUnavailableToCaller(ctx, sessionId) || !runtime.sessionStore.load(sessionId)) throw new SessionNotFoundError(sessionId);
    return runtime.getSessionWorkspace(sessionId);
  }
  return query.get("workspace") === "true"
    ? runtime.getSessionWorkspace(runtime.createSession({ persist: false }))
    : null;
}
