import { exportChat, isIncognitoSession, parseChatExportFormat, type SessionState } from "../session/index.js";
import { readSessionTitle } from "../session/session-title.js";
import { getConfig } from "../config/index.js";
import { runtimeKnownSecrets } from "../runtime/runtime-known-secrets.js";
import { describeToolCall } from "../tools/describe-tool-call.js";
import { openaiError } from "./openai-errors.js";
import { sendError, sendJson, type HttpHandler } from "./request-context.js";

/** Bound Markdown parsing, redaction and document layout on the HTTP event loop. */
function exportTooLarge(state: SessionState, includeTools: boolean): boolean {
  let records = 0;
  let chars = (readSessionTitle(state.metadata)?.length ?? 60) + 100;
  for (const turn of state.turns) {
    if (turn.kind === "user") chars += turn.text.length + 100;
    else if (turn.kind === "assistant_reply") {
      chars += (turn.stopped ? 20 : turn.text.length) + 100;
      if (!turn.stopped) for (const path of turn.attachments ?? []) {
        chars += path.length + 8;
        if (chars > 1_000_000) return true;
      }
    } else if (turn.kind === "assistant_tool_call" && includeTools) {
      chars += describeToolCall({ name: turn.tool, args: turn.args, ok: true }).line.length + 100;
    } else continue;
    if (++records > 2_000 || chars > 1_000_000) return true;
  }
  return chars > 1_000_000;
}

/**
 * `GET /api/sessions/{id}/export?format=markdown|html|docx|pdf[&tools=0]` —
 * one chat as a document (ATO-1054).
 *
 * The answer is JSON, not the raw file, so a client that already speaks
 * JSON to this server needs nothing new to read it:
 * `{ id, format, filename, mimeType, encoding, content }`, where
 * `encoding` is `utf8` for Markdown and HTML and `base64` for DOCX and
 * PDF. The client writes `content` to wherever the person chose. The
 * desktop prints the `html` format itself (Electron `printToPDF`), which
 * keeps all writing systems; `pdf` is the browserless writer the terminal uses.
 *
 * `format` defaults to Markdown and also takes `md` / `word`; anything
 * else is `400`. `tools=0` leaves out the one-line-per-tool-step list.
 * `404` when the session is not persisted; `409 incognito_session` for an
 * incognito chat (ATO-586), which leaves nothing behind.
 */
export function createExportSessionHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const id = ctx.params.id;
    if (!id) {
      sendError(res, 400, openaiError("session id is required"));
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const format = parseChatExportFormat(url.searchParams.get("format"));
    if (!format) {
      sendError(res, 400, openaiError("format must be markdown, html, docx or pdf", "invalid_request_error", "format"));
      return;
    }
    const state = ctx.runtime.sessionStore.load(id);
    if (!state) {
      sendError(res, 404, openaiError(`session not found: ${id}`));
      return;
    }
    if (isIncognitoSession(state)) {
      // An incognito chat (ATO-586) is meant to leave nothing behind; a
      // document of it would outlive the chat.
      sendError(res, 409, openaiError("an incognito chat cannot be exported", "invalid_request_error", null, "incognito_session"));
      return;
    }
    const includeTools = url.searchParams.get("tools") !== "0";
    if (exportTooLarge(state, includeTools)) {
      sendError(res, 413, openaiError("chat is too large for HTTP export; use export from your terminal", "invalid_request_error", null, "export_too_large"));
      return;
    }
    const file = await exportChat(state, format, {
      includeTools,
      // The config's stored keys too, not only the .env ones (ATO-1077
      // set); read per request, so a key added mid-session is covered.
      knownSecrets: runtimeKnownSecrets(getConfig()),
      describeToolCall: (call) => describeToolCall({ name: call.tool, args: call.args, ok: call.ok }).line,
    });
    const binary = typeof file.body !== "string";
    sendJson(res, 200, {
      id: state.id,
      format: file.format,
      filename: file.filename,
      mimeType: file.mimeType,
      encoding: binary ? "base64" : "utf8",
      content: binary ? (file.body as Buffer).toString("base64") : file.body,
    });
  };
}
