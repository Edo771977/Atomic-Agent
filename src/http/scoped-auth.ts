import type { IncomingMessage, ServerResponse } from "node:http";

import type { AuthThrottle } from "./auth-throttle.js";
import { roleHasScope, type HttpRole, type HttpScope } from "./http-scopes.js";
import { hashHttpToken, type StoredHttpToken } from "./http-token-store.js";
import { openaiError } from "./openai-errors.js";
import {
  enforceAuth,
  getBearerToken,
  getHeader,
  sendAuthThrottled,
  sendInvalidApiKey,
  sendJson,
} from "./request-context.js";
import { secretEquals } from "./secret-equal.js";

/** Who sent a request: the serve key, or one named token. */
export interface HttpCaller {
  /** The token's name; `api-key` for the serve key. */
  name: string;
  role: HttpRole | "owner";
}

export interface ScopedAuthInput {
  apiKey: string | null;
  namedTokens?: () => readonly StoredHttpToken[];
  /** What the matched route needs. */
  scope: HttpScope;
  /** `"POST /api/config"`, for the 403 message. */
  route: string;
  onAuthorized?: (caller: HttpCaller, stillAuthorized?: () => boolean) => void;
}

/**
 * Match a presented token against the serve key (owner) and every named
 * token. Each named token is compared in constant time on its hash, and
 * the loop never stops early, so timing does not say which one matched.
 */
export function identifyCaller(
  presented: string | null,
  apiKey: string,
  namedTokens: () => readonly StoredHttpToken[],
): HttpCaller | null {
  if (secretEquals(presented, apiKey)) return { name: "api-key", role: "owner" };
  if (typeof presented !== "string" || presented.length === 0) return null;
  const hash = hashHttpToken(presented);
  let found: StoredHttpToken | null = null;
  for (const token of namedTokens()) {
    if (secretEquals(hash, token.sha256) && found === null) found = token;
  }
  return found ? { name: found.name, role: found.role } : null;
}

/**
 * ATO-583: auth plus scope for one request. Returns `true` when the
 * handler may run; otherwise the response is already sent.
 *
 * The serve key authorizes all routes. Named tokens authorize their role scopes.
 */
export function authorizeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  input: ScopedAuthInput,
  throttle?: AuthThrottle,
): boolean {
  if (input.apiKey === null || !input.namedTokens) {
    const allowed = enforceAuth(req, res, input.apiKey, throttle);
    if (allowed && input.apiKey !== null) input.onAuthorized?.({ name: "api-key", role: "owner" });
    return allowed;
  }
  const address = req.socket?.remoteAddress;
  const wait = throttle ? throttle.retryAfter(address) : 0;
  if (wait > 0) {
    sendAuthThrottled(res, wait);
    return false;
  }
  const presented = getBearerToken(req) ?? getHeader(req, "x-api-key");
  const caller = identifyCaller(presented, input.apiKey, input.namedTokens);
  if (!caller) {
    throttle?.failed(address);
    sendInvalidApiKey(res);
    return false;
  }
  if (caller.role === "owner") throttle?.ownerSucceeded(address);
  if (caller.role === "owner") {
    input.onAuthorized?.(caller);
    return true;
  }
  if (roleHasScope(caller.role, input.scope)) {
    const hash = hashHttpToken(presented!);
    const registry = input.namedTokens;
    input.onAuthorized?.(caller, () => {
      let allowed = false;
      for (const token of registry()) {
        if (secretEquals(hash, token.sha256) && token.name === caller.name &&
            roleHasScope(token.role, input.scope)) allowed = true;
      }
      return allowed;
    });
    return true;
  }
  sendJson(
    res,
    403,
    openaiError(
      `Token has the ${caller.role} role and cannot use ${input.route}: it needs the ${input.scope} scope`,
      "permission_error",
      null,
      "insufficient_scope",
    ),
  );
  return false;
}
