import { rmSync } from "node:fs";
import { resolve, sep } from "node:path";

import { isIncognitoSession, type IncognitoMark } from "../session/incognito.js";
import type { SessionStore } from "../session/session-store.js";
import type { TaskStore } from "../tasks/task-store.js";
import { traceFilePath } from "../tracing/trace/trace-sink.js";
import type { StructuredLogger } from "../tracing/structured-logger.js";

/**
 * Closing incognito chats (ATO-586, `src/session/incognito.ts`): the row,
 * its archived turns and its trace file go when the chat is closed — the
 * TUI leaving it, `run --incognito` ending, a client deleting it — and at
 * the next start for a chat whose process died first. Closing also drops
 * the tasks bound to it, so none runs later in an ordinary chat.
 */

/**
 * Best effort, like the retention pass's own trace removal: a chat whose
 * tracing was off has no file, and a file that cannot be removed must not
 * fail a close or a boot. Refuses a path outside the traces folder.
 */
export function removeIncognitoTrace(
  tracesDir: string | null | undefined,
  sessionId: string,
): boolean {
  if (!tracesDir) return false;
  const path = traceFilePath(tracesDir, sessionId);
  if (!resolve(path).startsWith(`${resolve(tracesDir)}${sep}`)) return false;
  try {
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * The boot half: delete the incognito chats a dead process left behind,
 * with their trace files. Never throws — a sweep that fails leaves the
 * rows for the next start and costs the user nothing else.
 */
export function sweepOrphanIncognitoSessions(
  sessionStore: Pick<SessionStore, "sweepOrphanIncognito">,
  tracesDir: string | null | undefined,
  logger: Pick<StructuredLogger, "info" | "warn">,
): string[] {
  try {
    const ids = sessionStore.sweepOrphanIncognito();
    for (const id of ids) removeIncognitoTrace(tracesDir, id);
    if (ids.length > 0) {
      logger.info("deleted incognito chats left by a stopped agent", {
        count: ids.length,
      });
    }
    return ids;
  } catch (err) {
    logger.warn("could not delete incognito chats left by a stopped agent; continuing", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** What `discard` did. */
export type IncognitoDiscardOutcome =
  /** Row and trace deleted now. */
  | "deleted"
  /** A turn is running on it: deleted when that turn ends (`settle`). */
  | "deferred"
  /** No stored incognito chat by that id (never sent to, or not incognito). */
  | "not_incognito";

export interface IncognitoSessionsDependencies {
  /** `delete` is the runtime's wrapped one: recorder, shell jobs, spill. */
  sessionStore: Pick<SessionStore, "isIncognito" | "delete">;
  tracesDir: string | null | undefined;
  /** Whether a turn is running on the session (`TurnController.isBusy`). */
  isBusy: (sessionId: string) => boolean;
  /**
   * The task queue: a closed chat's tasks go with it, prompt and all, so
   * none runs later in an ordinary chat. Absent in callers with no queue.
   */
  taskStore?: Pick<TaskStore, "removeForSession">;
  /**
   * The managed chat server's prompt cache on disk (ATO-456). An
   * incognito turn marks the launch private so the next stop saves no
   * slot; closing the chat erases the slots that held its prompt. Both
   * best effort; absent in callers with no local server.
   */
  promptCache?: {
    markPrivate(): void;
    eraseSlots(slotIds: readonly number[]): void | Promise<unknown>;
  };
  /** The server slots a session's prompt was in (its pin, the side-call slot). */
  slotsOf?: (sessionId: string) => readonly number[];
  logger: Pick<StructuredLogger, "warn">;
}

/**
 * The close half. `discard` never deletes a chat that is not incognito,
 * and never pulls the row out from under a running turn: the turn's own
 * end would write it back. It waits for `settle`, which the turn service
 * calls once every turn has ended and saved.
 */
export function createIncognitoSessions(deps: IncognitoSessionsDependencies) {
  const pending = new Set<string>();

  const eraseSlots = (sessionId: string): void => {
    try {
      const slots = deps.slotsOf?.(sessionId) ?? [];
      if (slots.length === 0 || !deps.promptCache) return;
      void Promise.resolve(deps.promptCache.eraseSlots(slots)).catch(() => {
        /* best effort: the launch stays marked private, so no stop saves it */
      });
    } catch {
      /* as above */
    }
  };

  const remove = (sessionId: string): boolean => {
    try {
      if (!deps.sessionStore.isIncognito(sessionId)) return false;
      deps.taskStore?.removeForSession(sessionId);
      deps.sessionStore.delete(sessionId);
      removeIncognitoTrace(deps.tracesDir, sessionId);
      eraseSlots(sessionId);
      return true;
    } catch (err) {
      // Left for the next start's sweep.
      deps.logger.warn("could not delete an incognito chat; the next start will", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  };

  const discard = (sessionId: string): IncognitoDiscardOutcome => {
    if (deps.isBusy(sessionId)) {
      pending.add(sessionId);
      return "deferred";
    }
    pending.delete(sessionId);
    return remove(sessionId) ? "deleted" : "not_incognito";
  };

  const settle = (sessionId: string): void => {
    if (!pending.has(sessionId)) return;
    // Another turn queued behind the one that ended keeps the chat open.
    if (deps.isBusy(sessionId)) return;
    pending.delete(sessionId);
    remove(sessionId);
  };

  /** Before an incognito turn runs: keep this launch's slots off the disk. */
  const noteTurn = (session: { readonly incognito?: IncognitoMark | undefined }): void => {
    if (!isIncognitoSession(session)) return;
    try {
      deps.promptCache?.markPrivate();
    } catch {
      /* best effort, like the save it guards */
    }
  };

  return { discard, settle, noteTurn };
}
