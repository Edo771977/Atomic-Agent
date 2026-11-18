import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { getConfig } from "../config/index.js";
import { hasProjectConstraints } from "../llm/provider-policy.js";
import { openaiError } from "./openai-errors.js";
import { readJsonBody, sendError, sendJson, type HttpHandler } from "./request-context.js";

/**
 * ATO-731: each chat has its own working folder (`SessionState.workingDir`,
 * which every tool step already reads), so a client changes the folder of
 * one chat, or opens a chat in another folder, without restarting `serve`.
 */

/** An absolute path to an existing directory, normalised; or why not. */
export function checkWorkingDir(raw: unknown): { ok: true; dir: string } | { ok: false; error: string } {
  if (typeof raw !== "string" || raw.trim().length === 0) return { ok: false, error: "workingDir must be a non-empty string" };
  if (/[\r\n\x00]/.test(raw)) return { ok: false, error: "workingDir is not a path" };
  if (!isAbsolute(raw)) return { ok: false, error: "workingDir must be an absolute path" };
  const dir = resolve(raw);
  try {
    if (!statSync(dir).isDirectory()) return { ok: false, error: `${dir} is not a folder` };
  } catch {
    return { ok: false, error: `${dir} does not exist` };
  }
  return { ok: true, dir };
}

/**
 * `POST /api/sessions/{id}/working-dir` — `{ workingDir }`: move one chat to
 * another folder. `409 turn_in_progress` while that chat runs a turn (its
 * tools would change folder mid-turn); other chats' turns do not matter.
 * A chat whose folder or read taint restricts it keeps that restriction
 * (issue #68, `moveSessionFolder`); the answer names it in `restriction`
 * (the chat's restriction after the move, or `null`) and
 * `restrictionKept` (whether the old one was carried).
 */
export function createSetSessionWorkingDirHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const id = ctx.params.id ?? "";
    let body: unknown;
    try {
      body = await readJsonBody<unknown>(req);
    } catch (err) {
      sendError(res, 400, openaiError(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    const check = checkWorkingDir((body as { workingDir?: unknown } | null)?.workingDir);
    if (!check.ok) {
      sendError(res, 400, openaiError(check.error, "invalid_request_error", "workingDir"));
      return;
    }
    const session = ctx.runtime.sessionStore.load(id);
    if (!session) {
      sendError(res, 404, openaiError(`session ${JSON.stringify(id)} not found`));
      return;
    }
    // This process's turn, or one another process on the same state dir runs (the store's `running`).
    if (ctx.runtime.turnController.isBusy(id) || session.status === "running") {
      sendError(res, 409, openaiError("this chat has a turn in progress; change its folder when it finishes", "invalid_request_error", null, "turn_in_progress"));
      return;
    }
    // Issue #68: a restricted chat keeps its restriction wherever it goes. A
    // runtime that cannot carry it may not move a chat while constraints exist.
    const move = ctx.runtime.moveSessionFolder;
    if (move === undefined && hasProjectConstraints(getConfig())) {
      sendError(res, 501, openaiError("this server cannot keep a chat's folder restriction when it moves; the chat was not moved", "invalid_request_error", null, "restriction_unavailable"));
      return;
    }
    const moved = move?.(session, check.dir)
      ?? { session: { ...session, workingDir: check.dir }, restriction: null, restrictionKept: false };
    ctx.runtime.sessionStore.save(moved.session);
    sendJson(res, 200, { id, workingDir: check.dir, restriction: moved.restriction, restrictionKept: moved.restrictionKept });
  };
}
