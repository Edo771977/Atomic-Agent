/**
 * `POST /api/ag-ui` (ATO-694): run one turn and stream it as AG-UI events.
 *
 * A second way in next to `/v1/chat/completions`, for web frontends built
 * on AG-UI (CopilotKit, `@ag-ui/client`'s `HttpAgent`) so they talk to
 * `atag serve` without learning our own frames. The body is AG-UI's
 * `RunAgentInput`:
 *
 *   { threadId, runId, messages: [{ id, role, content }], state?, tools?, context?, forwardedProps? }
 *
 * `threadId` is the session id: the same thread resumes the same chat, a
 * new one starts a chat in the server's folder. The turn's input is the
 * last `user` message (string content, or the `text` parts of a content
 * array); earlier messages are not replayed, the session keeps its own
 * history. `tools`, `context` and `state` are accepted and not used yet:
 * the agent runs its own tools, and its state is the plan it sends back as
 * `STATE_SNAPSHOT`.
 *
 * The answer is `text/event-stream`, one `data: <event JSON>` per event
 * (`ag-ui-events.ts` has the mapping), ending with `RUN_FINISHED` or
 * `RUN_ERROR`. Closing the connection stops the turn, as AG-UI's
 * `abortRun` does. Approval prompts still arrive on `GET /api/events` and
 * are answered on `POST /api/approval/resolve`.
 *
 * Purely additive: nothing on the existing routes changes. Bearer auth
 * like every `/api` route.
 */
import type { ServerResponse } from "node:http";

import type { RunTurnResult } from "../agent/agent-contract.js";
import { createEmptySessionState, type SessionState } from "../session/index.js";

import { createAgUiTranslator } from "./ag-ui-events.js";
import { isValidSessionId } from "../session/session-id.js";
import { openaiError } from "./openai-errors.js";
import { SERVE_RESTRICTED_CODE, SERVE_RESTRICTED_NOTICE, serveWithheld } from "./serve-egress.js";
import {
  beginSse,
  onClientGone,
  readJsonBody,
  sendError,
  SSE_HEARTBEAT_MS,
  type HandlerContext,
  type HttpHandler,
} from "./request-context.js";

/** Longest `threadId` / `runId` accepted. */
const ID_MAX = 200;

export interface AgUiRunInput {
  threadId: string;
  runId: string;
  userMessage: string;
}

/** Parse a `RunAgentInput` body; a string is the reason it was refused. */
export function parseAgUiRunInput(body: unknown): AgUiRunInput | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "Body must be an AG-UI RunAgentInput object";
  }
  const input = body as Record<string, unknown>;
  const threadId = input["threadId"];
  const runId = input["runId"];
  if (!isId(threadId) || !isValidSessionId(threadId)) return "Missing or invalid 'threadId'";
  if (!isId(runId)) return "Missing or invalid 'runId'";
  const messages = input["messages"];
  if (!Array.isArray(messages)) return "Missing or invalid 'messages'";
  let userMessage = "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as Record<string, unknown> | null;
    if (typeof message !== "object" || message === null || message["role"] !== "user") continue;
    userMessage = messageText(message["content"]);
    break;
  }
  if (userMessage.trim().length === 0) return "No user message with text content found in 'messages'";
  return { threadId, runId, userMessage };
}

export function createAgUiRunHandler(): HttpHandler {
  return async (req, res, ctx) => {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 400, openaiError(`Invalid JSON in request body: ${message}`));
      return;
    }
    const input = parseAgUiRunInput(body);
    if (typeof input === "string") {
      sendError(res, 400, openaiError(input));
      return;
    }
    const session = resolveThreadSession(input.threadId, ctx);
    // Issue #33: a network server refuses a restricted session's turn
    // before it runs, like `/v1/chat/completions`.
    if (serveWithheld(ctx, session)()) {
      sendError(res, 403, openaiError(SERVE_RESTRICTED_NOTICE, "permission_error", null, SERVE_RESTRICTED_CODE));
      return;
    }
    await runAgUiTurn(res, ctx, session, input);
  };
}

async function runAgUiTurn(
  res: ServerResponse,
  ctx: HandlerContext,
  session: SessionState,
  input: AgUiRunInput,
): Promise<void> {
  const controller = new AbortController();
  const sse = beginSse(res, {}, { heartbeatMs: SSE_HEARTBEAT_MS, ...(ctx.stillAuthorized ? { stillAuthorized: ctx.stillAuthorized, onUnauthorized: () => controller.abort() } : {}) });
  const translator = createAgUiTranslator({
    threadId: input.threadId,
    runId: input.runId,
    emit: (event) => {
      if (!sse.closed) sse.writeEvent(null, event);
    },
  });
  onClientGone(res, () => controller.abort());
  translator.runStarted();

  // Once a read taints the turn mid-way, nothing more of it is written
  // and the turn is stopped (issue #33).
  const withheld = serveWithheld(ctx, session);
  let cut = false;
  let result: RunTurnResult | null = null;
  let error: Error | null = null;
  try {
    result = await ctx.runtime.runTurn(session, input.userMessage, {
      signal: controller.signal,
      origin: "http",
      ...(ctx.caller && ctx.caller.role !== "owner" ? { requestedByToken: ctx.caller.name } : {}),
      eventHook: (event) => {
        if (cut) return;
        if (withheld()) {
          cut = true;
          controller.abort();
          return;
        }
        translator.onEvent(event);
      },
    });
  } catch (err) {
    error = err instanceof Error ? err : new Error(String(err));
  }
  // A steer this turn accepted and never showed the model is parked where
  // `GET /api/sessions/{id}/steer` finds it, as after a chat stream.
  ctx.undeliveredSteers.park(session.id, result?.undelivered ?? []);

  if (cut || withheld()) {
    translator.failed(SERVE_RESTRICTED_NOTICE);
  } else if (error) {
    translator.failed(error.message);
  } else if (result!.session.status === "failed") {
    translator.failed(result!.session.lastError ?? "Agent loop failed");
  } else {
    translator.finished(result!);
  }
  sse.close();
}

/** The thread's session, or a new one in the server's folder. */
function resolveThreadSession(threadId: string, ctx: HandlerContext): SessionState {
  const existing = ctx.runtime.sessionStore.load(threadId);
  if (existing) return existing;
  const state = createEmptySessionState({
    id: threadId,
    workingDir: ctx.runtime.capabilities.workingDir,
    metadata: { source: "ag-ui" },
  });
  ctx.runtime.sessionStore.save(state);
  return state;
}

function isId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= ID_MAX &&
    // No control characters: the id becomes a session id.
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

/** A message's text: a string, or the `text` parts of AG-UI content parts. */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof part === "object" &&
      part !== null &&
      (part as Record<string, unknown>)["type"] === "text" &&
      typeof (part as Record<string, unknown>)["text"] === "string"
        ? ((part as Record<string, unknown>)["text"] as string)
        : "",
    )
    .filter((text) => text.length > 0)
    .join("\n");
}
