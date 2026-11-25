import { openaiError } from "./openai-errors.js";
import { readJsonBody, sendError, sendJson, type HandlerContext, type HttpHandler } from "./request-context.js";
import { canReadSession } from "./serve-egress.js";
import type { PrivacyShieldControl } from "../runtime/runtime-contract.js";

/**
 * `GET`, `POST` and `PATCH /api/privacy-shield` (ATO-1082, the
 * contract the desktop's Settings › Privacy row reads). Same shape as
 * `/api/offline-mode`.
 *
 * GET answers `{ enabled, masked, sessions }`: whether Privacy Shield is
 * on, and how many distinct values (emails, phones, cards, IBANs, keys)
 * retained chat archives contain, over how many chats. `?sessionId=<id>` adds `session: { masked, lastRequest }`
 * for that chat. POST and PATCH take `{ enabled: boolean }`, persists
 * `privacy.shield.enabled`, applies it to new turns and
 * answers the same shape.
 */
function snapshot(control: PrivacyShieldControl, sessionId: string | null, ctx: HandlerContext) {
  const unavailable = sessionId !== null && ctx.caller !== undefined && ctx.caller.role !== "owner"
    && !canReadSession(ctx, ctx.runtime.sessionStore.load(sessionId));
  const { masked, sessions, session } = control.stats(unavailable ? undefined : sessionId ?? undefined);
  return {
    enabled: control.isEnabled(),
    masked,
    sessions,
    ...(unavailable ? { session: { masked: 0, lastRequest: 0 } }
      : session ? { session: { masked: session.masked, lastRequest: session.lastRequest } } : {}),
  };
}

function sessionIdOf(url: string | undefined): string | null {
  const id = new URL(url ?? "/", "http://localhost").searchParams.get("sessionId");
  return id && id.length > 0 ? id : null;
}

export function createGetPrivacyShieldHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const control = ctx.runtime.privacyShield;
    if (!control) {
      sendError(res, 501, openaiError("privacy shield is not available in this runtime"));
      return;
    }
    sendJson(res, 200, snapshot(control, sessionIdOf(req.url), ctx));
  };
}

export function createSetPrivacyShieldHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const control = ctx.runtime.privacyShield;
    if (!control) {
      sendError(res, 501, openaiError("privacy shield is not available in this runtime"));
      return;
    }
    let body: { enabled?: unknown } | null;
    try {
      body = await readJsonBody<{ enabled?: unknown }>(req);
    } catch {
      sendError(res, 400, openaiError("Invalid JSON"));
      return;
    }
    if (typeof body?.enabled !== "boolean") {
      sendError(res, 400, openaiError("enabled must be a boolean", "invalid_request_error", "enabled"));
      return;
    }
    try {
      await control.setEnabled(body.enabled);
    } catch {
      sendError(res, 500, openaiError("could not switch privacy shield", "server_error"));
      return;
    }
    sendJson(res, 200, snapshot(control, sessionIdOf(req.url), ctx));
  };
}
