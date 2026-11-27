import { exportChat, isIncognitoSession, parseChatExportFormat } from "../session/index.js";
import { getConfig } from "../config/index.js";
import { runtimeKnownSecrets } from "../runtime/runtime-known-secrets.js";
import { describeToolCall } from "../tools/describe-tool-call.js";
import { openaiError } from "./openai-errors.js";
import { sendError, sendJson, type HttpHandler } from "./request-context.js";

/** Bound Markdown parsing, redaction and document layout on the HTTP event loop. */
function exportTooLarge(state: { turns: readonly unknown[] }): boolean {
  if (state.turns.length > 2_000) return true;
  let charsLeft = 1_000_000;
  let nodesLeft = 20_000;
  const exceeds = (value: unknown, depth: number): boolean => {
    if (--nodesLeft < 0 || depth > 32) return true;
    if (typeof value === "string") return (charsLeft -= value.length) < 0;
    if (value !== null && typeof value === "object") {
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        charsLeft -= key.length;
        if (charsLeft < 0 || exceeds((value as Record<string, unknown>)[key], depth + 1)) return true;
      }
    }
    return false;
  };
  return exceeds(state, 0);
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
    if (exportTooLarge(state)) {
      sendError(res, 413, openaiError("chat is too large for HTTP export; use export from your terminal", "invalid_request_error", null, "export_too_large"));
      return;
    }
    const file = await exportChat(state, format, {
      includeTools: url.searchParams.get("tools") !== "0",
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
