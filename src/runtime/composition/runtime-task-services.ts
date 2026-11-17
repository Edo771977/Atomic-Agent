import { homedir } from "node:os";
import { resolve } from "node:path";
import type { AtomicAgentConfig } from "../../config/index.js";
import {
  openPerCallHeartbeatStore,
  parseQuietHours,
  SqliteHeldReportStore,
  TaskReportHold,
  TaskRunner,
  TaskStore,
  type TaskReportSink,
} from "../../tasks/index.js";
import type { TaskRunnerRuntime } from "../../tasks/task-runner.js";
import type { TaskRecord } from "../../tasks/index.js";
import {
  chokidarWatcherFactory,
  createKeepAwake,
  createSchedulerLeadership,
  FileTriggerManager,
  nodeFileTriggerFs,
  parseKeepAwakeMode,
  realFileTriggerClock,
  Scheduler,
  type KeepAwake,
  type SchedulerSidecar,
  type FileTriggerFire,
} from "../../scheduler/index.js";
import { WebhookSessionStore, WEBHOOK_SESSIONS_FILENAME } from "../../http/webhook-session-store.js";
import { registerTaskTools } from "../../tools/tasks/index.js";
import { showDesktopNotification } from "../../tools/os/notify.js";
import type { ToolRegistry } from "../../tools/tool-registry.js";
import type { SessionStore } from "../../session/index.js";
import { TelegramChannel } from "../../channels/telegram/index.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { AgentMetrics } from "../../tracing/agent-metrics.js";
import type { AgentRuntime } from "../runtime-contract.js";
import type { TaskSessionInput } from "../../tools/tasks/index.js";
import type { SessionState } from "../../session/index.js";
import { childSessionSeed, type SessionProviderPolicy } from "../session-provider-policy.js";
import { createPushTaskReportSink, readCurrentPushConfig } from "../../notifications/index.js";

export function createRuntimeTaskStores(args: {
  config: Pick<AtomicAgentConfig, "paths" | "tasks">;
  logger: StructuredLogger;
}): { taskStore: TaskStore; webhookSessionStore: WebhookSessionStore } {
  const { config, logger } = args;
  const taskStore = new TaskStore({ dbFile: config.paths.tasksDbFile });
  const webhookSessionStore = new WebhookSessionStore(
    resolve(config.paths.stateDir, WEBHOOK_SESSIONS_FILENAME),
    {
      onCorrupt: (info) => {
        logger.warn("webhook session map was not valid JSON; persistent webhook bindings reset", {
          path: info.path,
          movedTo: info.movedTo ?? undefined,
          moveError: info.moveError,
        });
      },
    },
  );
  // A corrupt map would otherwise make every boot skip session retention
  // (it cannot tell which sessions the map pinned); moving it aside now
  // lets the next boot prune again.
  webhookSessionStore.recoverCorruptFile();
  if (taskStore.runOwnersUnavailable !== null) {
    logger.warn("task runs will not record their process; boot recovery falls back to age", {
      reason: taskStore.runOwnersUnavailable,
    });
  }
  // Recover claims from a stopped process before a scheduler can see the queue;
  // leave another live process's claims alone. A recovery failure cannot block boot.
  try {
    const recoveredTasks = taskStore.recoverInterrupted({
      staleAfterMs: config.tasks.staleAfterMs,
    });
    if (recoveredTasks.length > 0) {
      logger.info("tasks left running by a stopped agent put back to pending", {
        count: recoveredTasks.length,
        taskIds: recoveredTasks.join(","),
      });
    }
  } catch (err) {
    logger.warn("could not recover tasks left running; continuing", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return { taskStore, webhookSessionStore };
}

export function createRuntimeTaskRunner(args: {
  config: Pick<AtomicAgentConfig, "agent" | "tasks" | "paths" | "statusSnapshot">;
  taskStore: TaskStore;
  runTurn: TaskRunnerRuntime["runTurn"];
  sessionStore: Pick<SessionStore, "load" | "save" | "readTurnProgress" | "clearTurnProgress">
    & Partial<Pick<SessionStore, "isIncognito">>;
  /** The runtime's factory; `workingDir` puts a task's session in its caller's folder. */
  createSession: (input?: Parameters<AgentRuntime["createSession"]>[0] & { workingDir?: string }) => SessionState;
  toolRegistry: ToolRegistry;
  resolveTelegram: () => TelegramChannel | null;
  logger: StructuredLogger;
  metrics: AgentMetrics;
  /** The live approval level, so a task started under another is left alone (ATO-1324). */
  approvalLevel?: () => number;
  /** A constrained folder's veto on a task's notification, at send time (issue #33). */
  notifyRefusal?: (task: TaskRecord) => string | null;
  /**
   * Per-folder provider constraints (issue #33): a session a task tool
   * creates keeps its caller's folder and policy (`childSessionSeed`),
   * and a recurring task's deleted session is not recreated while any
   * constraint exists.
   */
  providerPolicy?: Pick<SessionProviderPolicy, "constraintsActive" | "effectivePolicyForSession">;
  /** Sleep inhibitor held while a drain runs (ATO-592). */
  keepAwake?: KeepAwake;
}): TaskRunner {
  const { config, taskStore, runTurn, sessionStore, createSession, toolRegistry, resolveTelegram, logger, metrics } = args;
  const taskRunner = new TaskRunner({
    store: taskStore,
    runtime: { runTurn },
    sessionLoader: sessionStore,
    sessionFactory: {
      create: (input) => createSession(input ?? {}),
      save: (state) => sessionStore.save(state),
    },
    defaultMaxSteps: config.agent.maxSteps,
    budgetedMaxSteps: config.agent.task.maxSteps,
    backoff: {
      initialMs: config.tasks.backoffInitialMs,
      maxMs: config.tasks.backoffMaxMs,
    },
    enabled: config.tasks.enabled,
    runOnCreate: config.tasks.runOnCreate,
    minIntervalMs: config.tasks.minIntervalMs,
    // One sink, routed per `TaskReport.notify`: phone push (ATO-1129)
    // goes straight to ntfy, everything else is the Telegram route. The
    // Telegram channel is constructed
    // after the runner — it needs the finished runtime object — so the
    // sink resolves the same live reference the shutdown path uses,
    // assigned further below, at delivery time. A report that fires in
    // the window before that assignment (a due task on an early
    // scheduler tick while bootstrap is still, e.g., awaiting MCP
    // connects) is warn-logged and dropped, never lost silently; skips
    // never affect the task's own status, and the runner isolates sink
    // rejections. Skip-path logging is pinned by the sink's own unit
    // tests in telegram-channel.test.ts.
    reportSink: routeTaskReports({
      telegram: createTaskReportSink({ config, resolveTelegram, logger }),
      push: createPushTaskReportSink({
        // Read per report from disk, not the boot config: `push on` from
        // the CLI or the desktop must reach a running agent.
        readPush: () => readCurrentPushConfig(config.paths.userConfigFile),
        logger,
      }),
    }),
    // Auto status snapshots of long reporting runs (ATO-965): one edited
    // Telegram message per task, silent inside quiet hours. Same late
    // channel resolution as the report sink.
    snapshotSink: TelegramChannel.buildTaskSnapshotSink({
      resolveChannel: resolveTelegram,
      quietHours: parseQuietHours(config.tasks.report?.quietHours ?? undefined),
    }),
    snapshotCadence: config.statusSnapshot ?? null,
    // Heartbeats (ATO-454): settings in tasks.sqlite, read per run; news
    // goes to Telegram through the report sink above and, when the
    // heartbeat asks, to a desktop notification.
    heartbeat: {
      store: openPerCallHeartbeatStore(config.paths.tasksDbFile),
      notifyDesktop: (title, message) => showDesktopNotification({ title, message }),
    },
    logger,
    metrics,
    ...(args.approvalLevel ? { approvalLevel: args.approvalLevel } : {}),
    ...(args.notifyRefusal ? { notifyRefusal: args.notifyRefusal } : {}),
    ...(args.providerPolicy ? { recreateSessionRefusal: recreateRefusalFor(args.providerPolicy) } : {}),
    ...(args.keepAwake ? { keepAwake: args.keepAwake } : {}),
    // Continue a run a crash, a kill or a restart cut off from its
    // session's checkpoint (ATO-1109).
    resume: {
      enabled: config.agent.task.resumeInterrupted,
      maxResumes: config.agent.task.maxResumes,
      progress: {
        read: (sessionId) => sessionStore.readTurnProgress(sessionId),
        clear: (sessionId) => sessionStore.clearTurnProgress(sessionId),
      },
    },
  });

  registerTaskTools(toolRegistry, {
    taskStore,
    taskRunner,
    createSession: createTaskToolSession(createSession, args.providerPolicy),
    agentToolsEnabled: config.tasks.enabled && config.tasks.agentToolsEnabled,
    defaultMaxAttempts: config.tasks.maxAttempts,
    defaultListLimit: 20,
    // ATO-586: an incognito chat cannot schedule tasks.
    ...(sessionStore.isIncognito
      ? { isIncognitoSession: (sessionId: string) => sessionStore.isIncognito!(sessionId) }
      : {}),
  });

  return taskRunner;
}

/** Send each report to its own target; unmarked reports are Telegram's. */
function routeTaskReports(sinks: {
  telegram: TaskReportSink;
  push: TaskReportSink;
}): TaskReportSink {
  return (report) =>
    report.notify === "push" ? sinks.push(report) : sinks.telegram(report);
}

/**
 * The factory the task tools call: a session created for a caller
 * (`parent`) starts in the caller's folder and carries the caller's
 * effective provider policy as its read taint (issue #33), so a task
 * scheduled from a constrained session cannot run unconstrained in the
 * runtime's folder.
 */
export function createTaskToolSession(
  createSession: (input?: { metadata?: Record<string, unknown>; workingDir?: string }) => SessionState,
  providerPolicy: Pick<SessionProviderPolicy, "constraintsActive" | "effectivePolicyForSession"> | undefined,
): (input?: TaskSessionInput) => SessionState {
  return (input = {}) => {
    const { parent, metadata } = input;
    if (parent === undefined) return createSession(metadata === undefined ? {} : { metadata });
    const seed = providerPolicy === undefined
      ? { workingDir: parent.workingDir, metadata: {} }
      : childSessionSeed(providerPolicy, parent);
    return createSession({ workingDir: seed.workingDir, metadata: { ...metadata, ...seed.metadata } });
  };
}

function recreateRefusalFor(
  providerPolicy: Pick<SessionProviderPolicy, "constraintsActive">,
): () => string | null {
  return () => providerPolicy.constraintsActive()
    ? "provider constraints are configured; a recreated session would lose the original folder and read taint"
    : null;
}

/**
 * The Telegram report route, wrapped in morning delivery when
 * `tasks.report.quietHours` is set: reports finishing inside the window
 * are held in tasks.sqlite and sent as one digest when it ends (see
 * `TaskReportHold`). Off by default; a malformed window is warned
 * about and treated as off rather than holding reports forever.
 */
function createTaskReportSink(args: {
  config: Pick<AtomicAgentConfig, "tasks" | "paths">;
  resolveTelegram: () => TelegramChannel | null;
  logger: StructuredLogger;
}): TaskReportSink {
  const { config, resolveTelegram, logger } = args;
  const direct = TelegramChannel.buildTaskReportSink({
    resolveChannel: resolveTelegram,
    logger,
  });
  const raw = config.tasks.report?.quietHours ?? null;
  if (raw === null) return direct;
  const quietHours = parseQuietHours(raw);
  if (quietHours === null) {
    logger.warn("task report quiet hours ignored: expected HH:MM-HH:MM", {
      value: raw,
    });
    return direct;
  }
  try {
    const hold = new TaskReportHold({
      quietHours,
      store: new SqliteHeldReportStore({ dbFile: config.paths.tasksDbFile }),
      deliverNow: direct,
      deliverDigest: TelegramChannel.buildTaskReportDigestSender({
        resolveChannel: resolveTelegram,
      }),
      logger,
    });
    hold.start();
    return hold.sink;
  } catch (err) {
    logger.warn("task report quiet hours unavailable; reports go out at once", {
      error: err instanceof Error ? err.message : String(err),
    });
    return direct;
  }
}

/**
 * The sleep inhibitor for tasks and turns (ATO-592), from
 * `ATOMIC_AGENT_TASKS_KEEP_AWAKE`. Default off; a value that is not
 * `off` / `while-working` (the removed `always` included) is warned
 * about and treated as off.
 */
export function createRuntimeKeepAwake(args: {
  config: Pick<AtomicAgentConfig, "tasks">;
  logger: StructuredLogger;
  platform?: NodeJS.Platform;
}): KeepAwake {
  const { config, logger } = args;
  const raw = config.tasks.keepAwake ?? null;
  let mode = parseKeepAwakeMode(raw);
  if (raw !== null && raw.trim() !== "" && mode === null) {
    logger.warn("keep-awake setting ignored: expected off or while-working", {
      value: raw,
      ...(raw.trim().toLowerCase() === "always"
        ? { hint: "always was removed: while-working keeps the computer awake only while a task or turn runs" }
        : {}),
    });
  }
  mode ??= "off";
  return createKeepAwake({
    mode,
    logger,
    ...(args.platform ? { platform: args.platform } : {}),
  });
}

export function createRuntimeScheduler(args: {
  config: Pick<AtomicAgentConfig, "tasks" | "paths" | "fileTriggers">;
  taskRunner: TaskRunner;
  logger: StructuredLogger;
  metrics: AgentMetrics;
  /**
   * The live Telegram channel, resolved per tick (it is constructed
   * after the scheduler). Absent or `null`: Telegram is not wanted here.
   */
  resolveTelegram?: () => Pick<TelegramChannel, "hasToken" | "state"> | null;
  /** Periodic work that runs only in the leading process (the mail trigger, ATO-601). */
  sidecars?: readonly SchedulerSidecar[];
}): Scheduler | null {
  const { config, taskRunner, logger, metrics, resolveTelegram, sidecars } = args;
  if (!config.tasks.enabled || !config.tasks.schedulerEnabled) return null;
  // ATO-416: the desktop's `atag serve` and the TUI can share this state
  // dir, each with a scheduler. Only one drains due tasks — the Telegram
  // owner when this process wants Telegram, else the holder of
  // `scheduler.lock` (see `scheduler-leadership.ts`).
  const leadership = createSchedulerLeadership({
    stateDir: config.paths.stateDir,
    telegramWanted: () => {
      const channel = resolveTelegram?.() ?? null;
      return channel !== null && channel.hasToken() && channel.state() !== "disabled";
    },
  });
  const fileTriggers = createFileTriggers({ config, taskRunner, logger });
  return new Scheduler({
    taskRunner,
    tickMs: config.tasks.schedulerTickMs,
    batch: config.tasks.schedulerBatch,
    logger,
    metrics,
    leadership,
    ...(fileTriggers
      ? { onLeadershipChange: (leading: boolean) => fileTriggers.setLeader(leading) }
      : {}),
    ...(sidecars && sidecars.length > 0 ? { sidecars } : {}),
  });
}

/**
 * File and log-line triggers (ATO-441). Watchers run only in the
 * scheduler leader (started and stopped through `onLeadershipChange`),
 * and each hit files a task the way a webhook hit does: the trigger
 * never calls `runTurn` itself. `null` when none are configured.
 */
function createFileTriggers(args: {
  config: Pick<AtomicAgentConfig, "tasks" | "fileTriggers">;
  taskRunner: Pick<TaskRunner, "create">;
  logger: StructuredLogger;
}): FileTriggerManager | null {
  const { config, taskRunner, logger } = args;
  const definitions = config.fileTriggers ?? {};
  if (Object.keys(definitions).length === 0) return null;
  return new FileTriggerManager({
    definitions,
    factory: chokidarWatcherFactory,
    fs: nodeFileTriggerFs,
    clock: realFileTriggerClock,
    homeDir: homedir(),
    logger,
    fire: (task: FileTriggerFire) => {
      try {
        const created = taskRunner.create({
          ...(task.sessionId ? { sessionId: task.sessionId } : {}),
          userMessage: task.userMessage,
          origin: "scheduler",
          triggerSource: "file",
          maxAttempts: config.tasks.maxAttempts,
          maxSteps: null,
        });
        logger.info("file trigger filed a task", { trigger: task.trigger, taskId: created.id });
      } catch (err) {
        logger.warn("file trigger could not file a task", {
          trigger: task.trigger,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  });
}
