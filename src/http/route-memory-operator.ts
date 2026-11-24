import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { createMemoryBackup, defaultBackupDir, MemoryBackupError } from "../memory/memory-backup.js";
import { MemoryValidationError } from "../memory/memory-store.js";
import { ProfileValidationError } from "../memory/profile-store.js";
import { checkOperatorJsonRequest } from "./loopback-guard.js";
import { memoryFingerprint, safeOperatorFact } from "./memory-operator-view.js";
import { openaiError } from "./openai-errors.js";
import { BodyParseError, readJsonBody, sendError, sendJson, type HandlerContext, type HttpHandler } from "./request-context.js";

class MemoryChoiceConflict extends Error {
  constructor(readonly code: "turn-running" | "incognito" | "stale-view" | "backup-running") {
    super(code);
  }
}

function assertIdle(ctx: HandlerContext): void {
  if (ctx.stillAuthorized?.() === false) throw new RequestError(403, "Authorization expired");
  const busy = ctx.runtime.turnController.busySessionIds();
  if (ctx.runtime.anyIncognitoOpen?.()
    || [...(ctx.incognitoChats ?? [])].some((id) => ctx.runtime.sessionStore.isIncognito(id))
    || busy.some((id) => ctx.runtime.sessionStore.isIncognito(id))) {
    throw new MemoryChoiceConflict("incognito");
  }
  if (busy.length) throw new MemoryChoiceConflict("turn-running");
}

function operatorPost(
  execute: (body: Record<string, unknown>, ctx: HandlerContext) => unknown,
): HttpHandler {
  return async (req, res, ctx) => {
    if (!ctx.caller) {
      return sendError(res, 401, openaiError("Authentication required", "invalid_request_error", null, "invalid_api_key"));
    }
    const rejection = checkOperatorJsonRequest(req);
    if (rejection) return sendError(res, rejection.status, openaiError(rejection.message, "invalid_request_error", null, rejection.code));
    let body: unknown;
    try {
      body = await readJsonBody<unknown>(req);
    } catch (error) {
      if (error instanceof BodyParseError) return sendError(res, 400, openaiError("Invalid JSON body"));
      throw error;
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return sendError(res, 400, openaiError("Expected a JSON object"));
    }
    try {
      assertIdle(ctx);
      const result = await execute(body as Record<string, unknown>, ctx);
      sendJson(res, 200, result);
    } catch (error) {
      if (error instanceof MemoryChoiceConflict) {
        const message = error.code === "stale-view" ? "Refresh the memory list and try again."
          : error.code === "incognito" ? "Unavailable while an incognito chat is open."
          : error.code === "backup-running" ? "A memory backup is already running."
          : "Wait for the turn to finish.";
        return sendError(res, 409, openaiError(message, "invalid_request_error", null, error.code));
      }
      if (error instanceof MemoryValidationError || error instanceof ProfileValidationError) {
        return sendError(res, 400, openaiError("Invalid memory entry"));
      }
      if (error instanceof RequestError) {
        return sendError(res, error.status, openaiError(error.message, "invalid_request_error", null, error.code));
      }
      if (error instanceof MemoryBackupError && error.code) {
        const message = {
          "backup-exists": "The backup destination is already in use.",
          "contains-credential": "Memory contains a credential. Remove it before backing up.",
          "no-database": "There is no memory database to back up.",
        }[error.code];
        return sendError(res, error.code === "backup-exists" ? 409 : 422,
          openaiError(message, "invalid_request_error", null, error.code));
      }
      ctx.runtime.logger.error("Memory operator request failed");
      sendError(res, 500, openaiError("Memory operation failed", "server_error"));
    }
  };
}

class RequestError extends Error {
  constructor(readonly status: 400 | 403 | 429, message: string, readonly code: string | null = null) {
    super(message);
  }
}

export function createMemoryStateHandler(kind: "note" | "profile"): HttpHandler {
  return operatorPost((body, ctx) => {
    const { enabled, fingerprint } = body;
    if (Object.keys(body).length !== 2 || typeof enabled !== "boolean"
      || typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)) {
      throw new RequestError(400, "An enabled flag and a full fingerprint are required");
    }
    const { notesStore, profileStore } = ctx.runtime;
    let changed = false;
    const check = (entry: Parameters<typeof memoryFingerprint>[0]) => {
      if (memoryFingerprint(entry) !== fingerprint) throw new MemoryChoiceConflict("stale-view");
      changed = (entry.disabledAt === undefined) !== enabled;
    };
    const now = Date.now();
    const disabledAt = enabled ? null : now;
    const id = ctx.params.id ?? "";
    if (kind === "note" && !/^[1-9]\d{0,15}$/.test(id)) throw new RequestError(400, "Invalid note ID");
    const entry = kind === "note"
      ? notesStore.changeDisabledAt(Number(id), disabledAt, now, check)
      : profileStore.changeDisabledAt(ctx.params.key ?? "", disabledAt, now, (fact) => {
        if (!safeOperatorFact(fact)) throw new MemoryChoiceConflict("stale-view");
        check(fact);
      });
    if (!entry) throw new MemoryChoiceConflict("stale-view");
    if (changed) ctx.memoryEvents?.emit("state");
    return { enabled: entry.disabledAt === undefined, fingerprint: memoryFingerprint(entry) };
  });
}

export function createMemoryBackupHandler(): HttpHandler {
  let running = false;
  let lastAttempt = -Infinity;
  return operatorPost(async (body, ctx) => {
    if (Object.keys(body).length !== 0) throw new RequestError(400, "Backup accepts an empty JSON object");
    if (running) throw new MemoryChoiceConflict("backup-running");
    const now = performance.now();
    if (now - lastAttempt < 60_000) throw new RequestError(429, "Wait one minute between HTTP backup attempts.", "backup-cooldown");
    lastAttempt = now;
    running = true;
    try {
      const paths = ctx.runtime.config.paths;
      const directory = `${defaultBackupDir(paths.stateDir)}-${randomUUID()}`;
      const file = await createMemoryBackup(paths, directory, () => assertIdle(ctx));
      const metadata = await stat(file);
      return { name: basename(directory), size: metadata.size, date: metadata.mtime.toISOString() };
    } finally {
      running = false;
    }
  });
}
