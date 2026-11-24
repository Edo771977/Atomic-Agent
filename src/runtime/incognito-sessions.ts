import { existsSync, rmSync } from "node:fs";
import { resolve, sep } from "node:path";

import { isFusionWorkerSessionId } from "../session/fusion-worker-session.js";
import { isIncognitoSession, type IncognitoMark } from "../session/incognito.js";
import type { SessionStore } from "../session/session-store.js";
import type { TurnOwnerProbe } from "../session/turn-owner.js";
import { TaskStore } from "../tasks/task-store.js";
import type { FusionRunStore } from "../tools/fusion/run-checkpoint.js";
import { traceFilePath } from "../tracing/trace/trace-sink.js";
import type { StructuredLogger } from "../tracing/structured-logger.js";

const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1_000;

/**
 * Closing incognito chats (ATO-586, `src/session/incognito.ts`): the row,
 * its archived turns, its trace file and its fusion run checkpoints go when the chat is closed — the
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
  try {
    const path = traceFilePath(tracesDir, sessionId);
    if (!resolve(path).startsWith(`${resolve(tracesDir)}${sep}`)) return false;
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * The tasks a dead process's incognito chat left in `tasks.sqlite`
 * (ATO-1547), dropped the way closing the chat drops them
 * (`TaskStore.removeForSession`). The task queue is built later in boot,
 * so this opens the file itself, once, and only when there is a chat to
 * sweep. No file means no tasks. Throws when the file cannot be opened or
 * written, so the sweep keeps that chat for the next start.
 */
function createIncognitoTaskSweeper(
  tasksDbFile: string | null | undefined,
  options: { staleAfterMs?: number; ownerProbe?: TurnOwnerProbe } = {},
): { removeTasks: (sessionId: string) => boolean; close: () => void } {
  let store: TaskStore | null = null;
  return {
    removeTasks: (sessionId) => {
      if (!tasksDbFile || !existsSync(tasksDbFile)) return true;
      store ??= new TaskStore({
        dbFile: tasksDbFile,
        ...(options.ownerProbe ? { ownerProbe: options.ownerProbe } : {}),
      });
      return store.removeForSessionAtBoot(sessionId, {
        staleAfterMs: options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
      }) !== null;
    },
    close: () => {
      try {
        store?.close();
      } catch {
        // Nothing to do with a handle that will not close.
      }
      store = null;
    },
  };
}

/**
 * The boot half: delete the incognito chats a dead process left behind,
 * with their trace files and, given `tasksDbFile`, the tasks bound to
 * them (ATO-1547). Never throws — a sweep that fails leaves the rows for
 * the next start and costs the user nothing else.
 */
export async function sweepOrphanIncognitoSessions(
  sessionStore: Pick<SessionStore, "sweepOrphanIncognito">,
  tracesDir: string | null | undefined,
  logger: Pick<StructuredLogger, "info" | "warn">,
  tasksDbFile?: string | null,
  taskOptions: { staleAfterMs?: number; ownerProbe?: TurnOwnerProbe } = {},
  removeArtifacts?: (sessionId: string, traceRemoved: boolean) => void | Promise<void>,
): Promise<{ deleted: string[]; retained: string[] }> {
  const retained: string[] = [];
  const tasks = createIncognitoTaskSweeper(tasksDbFile, taskOptions);
  try {
    const ids = await sessionStore.sweepOrphanIncognito(async (id) => {
      try {
        if (!tasks.removeTasks(id)) {
          retained.push(id);
          return false;
        }
      } catch (err) {
        retained.push(id);
        logger.warn("could not clean up an incognito chat left by a stopped agent; the next start will retry", {
          sessionId: id,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      const traceRemoved = !tracesDir || removeIncognitoTrace(tracesDir, id);
      try {
        await removeArtifacts?.(id, traceRemoved);
      } catch (err) {
        logger.warn("could not remove artifacts of an incognito chat", {
          sessionId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
    if (ids.length > 0) {
      logger.info("deleted incognito chats left by a stopped agent", {
        count: ids.length,
      });
    }
    return { deleted: ids, retained };
  } catch (err) {
    logger.warn("could not delete incognito chats left by a stopped agent; continuing", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { deleted: [], retained };
  } finally {
    tasks.close();
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
  sessionStore: Pick<SessionStore, "isIncognito" | "delete"> & Partial<Pick<SessionStore, "newIncognitoMark">>;
  tracesDir: string | null | undefined;
  /** Whether a turn is running on the session (`TurnController.isBusy`). */
  isBusy: (sessionId: string) => boolean;
  /**
   * The task queue: a closed chat's tasks go with it, prompt and all, so
   * none runs later in an ordinary chat. Absent in callers with no queue.
   */
  taskStore?: Pick<TaskStore, "removeForSession">;
  /** Fan-out checkpoints (ATO-617): a closed chat's stopped runs go with it. */
  fusionRuns?: Pick<FusionRunStore, "removeForSession">;
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
  /** Incognito chats a turn ran on here and not closed yet (a first turn has no row). */
  const open = new Map<string, IncognitoMark>();

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
      open.delete(sessionId);
      removeIncognitoTrace(deps.tracesDir, sessionId);
      deps.fusionRuns?.removeForSession(sessionId);
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
  const noteTurn = (session: { readonly id: string; readonly incognito?: IncognitoMark | undefined }): void => {
    if (!isIncognitoSession(session)) return;
    // A worker is never closed through `discard`; only chats are tracked.
    if (!isFusionWorkerSessionId(session.id)) open.set(session.id, session.incognito!);
    try {
      deps.promptCache?.markPrivate();
    } catch {
      /* best effort, like the save it guards */
    }
  };

  /**
   * A fusion worker spawned by an incognito chat is incognito too: it
   * reads and writes no memory and spills no output. The worker is never
   * stored, so the mark only steers its turn. A store that cannot answer
   * counts as incognito, the safer mistake.
   */
  const forWorker = <S extends { readonly incognito?: IncognitoMark | undefined }>(
    parentSessionId: string,
    worker: S,
  ): S => {
    if (isIncognitoSession(worker)) return worker;
    let mark = open.get(parentSessionId);
    if (mark === undefined) {
      let stored: boolean;
      try {
        stored = deps.sessionStore.isIncognito(parentSessionId);
      } catch {
        stored = true;
      }
      if (!stored) return worker;
      mark = deps.sessionStore.newIncognitoMark?.() ?? { since: Date.now(), owner: "" };
    }
    return { ...worker, incognito: mark };
  };

  /** Whether an incognito chat ran a turn here and is not closed yet: error reports hold (#29). */
  const anyOpen = (): boolean => open.size > 0;

  return { discard, settle, noteTurn, forWorker, anyOpen };
}
