/**
 * The shared half of the worker runner (ATO-1669): what any delegated
 * worker turn needs, Fusion or not. A separate ephemeral session and the
 * guard against colliding with the parent, progress into the parent's
 * frame, the approval policy, step and time limits, the turn itself, the
 * result row and stall detection.
 *
 * Fusion's add-ons (escalation, slot and queue watchdogs, local server
 * health, contract and declared inputs, spend, task tree, worktree
 * isolation, the judge, generation speed limits) are the
 * `Fusion...Extras` types below. Every one of them is optional and
 * documented as "absent: nothing happens", so a runner given only the
 * core fields is the same runner with those fields empty.
 *
 * Types only: the runner itself stays in `worker-runner.ts`, which keeps
 * its exported names (`WorkerRunnerDeps`, `RunWorkerTasksOptions`) as
 * core plus extras.
 */
import type { AgentLoopEvent, RunTurnResult } from "../../agent/agent-contract.js";
import type {
  CompletionUsage,
  ReasoningEffort,
} from "../../llm/provider/completion-types.js";
import type { ApprovalGate } from "../../approval/approval-gate.js";
import type { SessionState } from "../../session/session-state.js";
import type { FusionWorkerMeta } from "../../session/fusion-worker-session.js";
import type { TurnOrigin } from "../../runtime/turn-controller.js";
import type { FusionEscalationTarget } from "../../llm/run-mode/index.js";
import type { DeclaredInputsRegistry } from "../os/fs/fs-declared-inputs.js";
import type { FusionWorkerReasoning } from "../../config/llm-run-mode-config.js";
import type { ProjectLessonSource } from "../../session/project-lessons.js";
import type { TaskPermit } from "./task-permits.js";
import type { CheckRunRecorder, ContractCheckRunner } from "./contract-checks.js";
import type { KnownSecret } from "../../error-reporting/secret-detector.js";
import type { WatchJudgeCall, WatchClock } from "./worker-watch.js";
import type { StructuredLogger } from "../../tracing/index.js";
import type { ToolRole } from "../tool-roles.js";
import type { DelegateTask } from "./delegate-args.js";
import type { DelegateContract } from "./contract.js";
import type { EscalationComplete, FusionLiveWorkers } from "./escalation.js";
import type { LocalHealthAnswer, LocalLegHealth } from "./local-leg-health.js";
import type {
  SlotOccupancy,
  WorkerPricing,
  WorkerTaskResult,
} from "./worker-result.js";

/** The origin a worker turn runs under when the options name none. */
export const DEFAULT_WORKER_TURN_ORIGIN: TurnOrigin = "fusion";

export interface WorkerRunnerCoreDeps {
  /** Saved approval rules belong to this original project when cwd is a private candidate. */
  ruleWorkdir?: string;
  /** Runtime request-budget ownership, installed/cleared with the worker's approval policy. */
  workerBudget?: { bindSession(sessionId: string, parentSessionId: string): void; unbindSession(sessionId: string): void };
  /** `runtime.runTurn`, unchanged. */
  runTurn: (
    session: SessionState,
    userMessage: string,
    options: {
      origin?: TurnOrigin;
      providerId?: string;
      /** With `providerId`: the model the turn asks it for (`RunTurnOptions.model`). */
      model?: string;
      maxSteps?: number;
      taskMaxDurationMs?: number;
      toolFilter?: (name: string) => boolean;
      toolRole?: ToolRole;
      reasoningEffort?: ReasoningEffort;
      maxOutputTokens?: number;
      reasoningBudgetTokens?: number;
      signal?: AbortSignal;
      eventHook?: (event: AgentLoopEvent) => void;
    },
  ) => Promise<RunTurnResult>;
  /** `runtime.createEphemeralSession` — in-memory, never persisted. */
  createEphemeralSession: (meta: FusionWorkerMeta, workingDir?: string, inheritWorkspace?: boolean) => SessionState;
  inheritWorkspace?: boolean;
  workspaceTrustDir?: string;
  approvals: Pick<ApprovalGate, "setSessionPolicy" | "clearSessionPolicy"> &
    Partial<
      Pick<
        ApprovalGate,
        | "fanoutScopes"
        | "followDeclined"
        | "followTaint"
        | "holdsForOutsideContent"
        | "outsideContentSources"
        | "request"
        | "clearSessionGrants"
        | "hasDeclinedUnder"
        | "forgetDeclinedUnder"
        | "wouldPrompt"
      >
    >;
  /**
   * Where a worker's declared inputs (the contract's `inputs`, F51) are
   * registered for its session so `os.fs.write` refuses to replace
   * them. Absent (tests, embedders) declares nothing.
   */
  declaredInputs?: Pick<DeclaredInputsRegistry, "declare" | "clear">;
  /** Progress into the PARENT session's frame. */
  emitEvent: (sessionId: string, event: AgentLoopEvent) => void;
  workingDir: string;
  /** Where a raised task budget is logged. Absent, it is only noted on the row. */
  logger?: Pick<StructuredLogger, "info">;
}

export interface FusionWorkerRunnerDepsExtras {
  /**
   * The local server's slot table at this moment (`GET /slots`, read by
   * `readSlotOccupancy`), `null` when it gave no readable answer. Asked
   * once, by a local worker's queue watchdog just before it ends the
   * worker, so the hint on the row says what the server was doing rather
   * than guessing from the worker count. Absent (tests, embedders, a
   * cloud leg) nothing is probed and the hint says only what is known.
   */
  probeSlotOccupancy?: () => Promise<SlotOccupancy | null>;
  /**
   * The local leg's dispatch health across fan-outs (ATO-917): marked
   * when a local worker is cut off, checked before the next local worker
   * is sent. Absent (tests, embedders, a cloud leg) nothing is checked.
   */
  localLegHealth?: LocalLegHealth;
  /** `LlamaServerClient.probeHealth`, the question the check above asks. */
  probeLocalHealth?: () => Promise<LocalHealthAnswer>;
  /**
   * The probe for one local leg's own server (ATO-1318), or `undefined`
   * when nothing can ask that server; then the check is skipped for it.
   * When set it replaces `probeLocalHealth`, which only ever asks the
   * main local server.
   */
  probeLocalHealthFor?: (
    providerId: string,
  ) => (() => Promise<LocalHealthAnswer>) | undefined;
  /**
   * One completion on the escalation provider (ATO-942). Absent, nothing
   * is ever escalated, manual or automatic.
   */
  escalationComplete?: EscalationComplete;
  /** `runtime.steer`: how an advisor's hint reaches a running worker. */
  steerWorker?: (sessionId: string, text: string) => boolean;
  /** Where running workers are registered for the person's stop / escalate. */
  liveWorkers?: FusionLiveWorkers;
  /**
   * Replace the process's HTTP connection pool before a local worker is
   * sent after one was cut off and the server still answered
   * (`renewTransportPool`, ATO-1357). Returns whether it did. Absent
   * (tests, embedders), nothing is renewed.
   */
  renewLocalTransport?: () => boolean;
  /**
   * Runs a contract's `checks` (`verify.run` specs) — the verify tool
   * family's `runChecks`, wired by the runtime. Used after the fan-out
   * (`fusion-delegate.ts`) and by a worker's self-check before its reply
   * closes the task (`worker-self-check.ts`). Absent, declared checks
   * are reported as not run and never assumed to have passed.
   */
  runChecks?: ContractCheckRunner;
  recordCheckRun?: CheckRunRecorder;
  /**
   * The agent's own secrets (exact values: `.env`, the config's keys),
   * for masking check output that reaches a worker outside the tool
   * registry — the same list the registry masks tool results with
   * (ATO-1077). Absent: the environment's (`knownSecretsFromEnv`); the
   * detector's shape rules apply either way.
   */
  knownSecrets?: () => readonly KnownSecret[];
}

export interface WorkerRunnerCoreOptions {
  parentSessionId: string;
  tasks: readonly DelegateTask[];
  /** Concurrency ceiling, already reconciled against the slot pool. */
  maxWorkers: number;
  /** The local leg every worker turn is pinned to. */
  providerId: string;
  /**
   * The model every worker turn asks `providerId` for (a per-turn model,
   * a fusion team member's, issue #37). Absent, the provider's own.
   */
  model?: string;
  /**
   * Display label for the model the workers run on, already resolved by
   * the caller (`runMode.workerModel ?? providerId`). Resolved there
   * rather than here because the runner has no config access and must
   * never invent a name it cannot stand behind.
   */
  workerModel: string;
  workerMaxSteps: number;
  /**
   * Wall-clock ceiling per worker turn. With `localTokensPerSecond` it
   * is the ceiling of a per-task estimate (`estimateWorkerTimeoutMs`);
   * without, it is the limit itself.
   */
  workerTimeoutMs: number;
  /**
   * `runMode.fusion.workerReasoning`, sent with every worker completion
   * as the reasoning effort (a cloud leg's body builder reads it). On a
   * local leg, which has no such parameter, it picks the think-block
   * bound of every non-final worker step instead
   * (`localWorkerReasoningBudgetTokens`), bounded by default when unset.
   * `unbounded` sends no effort and lifts the local bound.
   */
  workerReasoning?: FusionWorkerReasoning;
  /**
   * `runMode.fusion.workerMaxOutputTokens`, the per-step output cap. A
   * measured local leg may send less: what fits the worker's time
   * (`fitReplyCapToTime`).
   */
  workerMaxOutputTokens?: number;
  /**
   * Directories these workers may write in without asking, as approved
   * by the operator on this fan-out's own prompt. Empty means nothing
   * was authorised — the workers then hit the refuse policy on every
   * write, exactly as they did before the fan-out prompt existed, and
   * the operator sees it as every task returning `needs_orchestrator`.
   */
  writeScope?: readonly string[];
  /**
   * The operator's request behind the orchestrator's turn, quoted into
   * every worker's brief as context (`renderWorkerBrief`). Absent when
   * the parent turn has none to give.
   */
  originalRequest?: string;
  signal: AbortSignal;
  /** Worker origin; defaults to fusion. */
  origin?: TurnOrigin;
}

export interface FusionWorkerRunnerOptionsExtras {
  /**
   * Every task id running at the same time as these (a wave, a judge's
   * retry), across all legs. A worker's self-check does not ask a
   * sibling's files of it (`concurrentPaths`). Absent: `tasks`.
   */
  concurrentTaskIds?: readonly string[];
  /** Shared call-wide admission, acquired before sessions and task clocks start. */
  acquireTaskPermit?: (signal: AbortSignal) => Promise<TaskPermit | undefined>;
  /**
   * The local leg's measured generation speed
   * (`LlamaServerClient.measuredTokensPerSecond`), `null` when nothing
   * has completed yet. Absent for a cloud leg, which keeps the ceiling.
   */
  localTokensPerSecond?: number | null;
  /**
   * The workers run on a local (slot-affine) leg. Turns on the local
   * floors (`LOCAL_WORKER_TASK_BUDGET_FLOOR_MS`,
   * `LOCAL_WORKER_FIRST_TOKEN_FLOOR_MS`) and the slot probe. Explicit
   * because `localTokensPerSecond` is `null` both on a cloud leg and on
   * a local one nothing has been measured on yet.
   */
  localLeg?: boolean;
  /** The fusion project's approved brief (issue #39), in every worker's brief. */
  project?: import("./worker-prompt.js").WorkerProjectBrief;
  projectLessonSource?: ProjectLessonSource;
  projectLessonIds?: (taskId: string) => readonly string[] | undefined;
  deferredProjectLessons?: Readonly<Record<string, string>>;
  /**
   * The fan-out's contract, rendered into every brief above the task
   * (`renderWorkerBrief`). Checked after the fan-out by the caller.
   */
  contract?: DelegateContract;
  /**
   * Asked before each task starts: a reason means the task is not
   * started and comes back `cancelled` with that reason (the turn's cap,
   * ATO-947). Absent, every task starts as before.
   */
  shouldStart?: () => string | undefined;
  /**
   * Asked only before a task starts, after `shouldStart`: the failure
   * breaker (ATO-1406). Unlike `shouldStart` it never refuses an
   * escalation or cuts a run already going, so running workers finish.
   */
  shouldStartTask?: () => string | undefined;
  /** Every worker completion's usage, as it lands (live spend, ATO-947). */
  onWorkerUsage?: (taskId: string, usage: CompletionUsage) => void;
  /**
   * Where a stuck worker may be escalated, and that model's price when
   * known (ATO-942). Absent: no escalation of any kind. `estimateOnly`
   * marks a price from the bundled models.dev snapshot: it estimates
   * what the advisor spent but never refuses its call by the worst case
   * nor enables the re-run, which both need verified pricing.
   */
  escalation?: { target: FusionEscalationTarget; pricing?: WorkerPricing; estimateOnly?: boolean };
  /** What an escalation cost, as it lands, for the turn's cap. */
  onEscalationSpend?: (taskId: string, usd: number) => void;
  /** The worker model's price, for the live $ on its row. Absent: tokens only. */
  workerPricing?: WorkerPricing;
  /**
   * Text appended to a task's brief: its acceptance checklist and, on a
   * judge's retry, what was found not met (ATO-944). Absent: the brief
   * is exactly as before.
   */
  briefSuffix?: (taskId: string) => string | undefined;
  /**
   * The workspace a task runs in instead of the working directory, and
   * the write scope rebased onto it (branch isolation, ATO-946). Absent,
   * or `undefined` for a task: the working directory, as before.
   */
  taskWorkspace?: (
    taskId: string,
  ) => { workingDir: string; writeScope: readonly string[] } | undefined;
  /**
   * The task tree (ATO-940): whether this task may still propose a
   * split. True, the half-budget hand-back and a cut first answer first
   * steer the worker toward a `split_proposal` (once, with
   * `SPLIT_GRACE_STEPS` more steps), and a reply that carries one skips
   * the declared-file check: the files are its children's to write.
   * Absent: exactly as before.
   */
  canProposeSplit?: (taskId: string) => boolean;
  /**
   * Every tool a worker starts, unthrottled (the feed's lines are capped
   * per task). The run checkpoint (ATO-617) records side effects from it.
   */
  onWorkerTool?: (taskId: string, tool: string) => void;
  /** Each task's row as soon as it is final, before the fan-out returns (ATO-617). */
  onTaskFinished?: (result: WorkerTaskResult) => void;
  /**
   * The watch on a running task (issue #43), fusion team runs only.
   * Absent, or `undefined` for a task: no watch, no timer.
   */
  watch?: (taskId: string) => WorkerWatchPlan | undefined;
}

export interface WorkerWatchPlan {
  intervalMs: number;
  /** Added to the first interval only, so parallel watches do not judge at once. */
  firstTickJitterMs?: number;
  /** Judge calls this run may still cost (the task's cap less its earlier runs'). */
  maxJudgeCalls: number;
  /** The task's whole cap (`team.watchMaxChecks`), for the note. */
  judgeCallCap?: number;
  /** The judge's label for the row and the hint's framing; null when none is named. */
  judgeLabel: string | null;
  judge: WatchJudgeCall;
  /** Tests drive the timer by hand; absent, the global one. */
  clock?: WatchClock;
}
