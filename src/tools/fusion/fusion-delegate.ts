import { checkDidNotRun } from "./check-ran.js";
import type { ApprovalGate } from "../../approval/approval-gate.js";
import {
  reviewEnabled,
  reviewPassesOf,
  watchEveryMinutesOf,
  watchMaxChecksOf,
  type TeamMember,
} from "../../llm/run-mode/fusion-team.js";
import { WATCH_JUDGE_MAX_OUTPUT_TOKENS, watchFirstTickJitterMs, type WatchClock } from "./worker-watch.js";
import { worstCaseCostUsd } from "./escalation.js";
import type { WorkerWatchPlan } from "./worker-runner.js";
import {
  ApprovalDeniedError,
  requireApproval,
} from "../../approval/dangerous-tool.js";
import { isAbsolute, relative, resolve as resolvePath } from "node:path";
import { isInside } from "../../approval/fanout-scope.js";
import { analyseFanoutScope } from "./fanout-paths.js";
import { resolveUserPath } from "../os/expand-home.js";
import { compressToolResult } from "../../compressor/result-compressor.js";
import type { CompressedToolResult } from "../../compressor/result-compressor.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import type { SlotManager } from "../../llm/slot-manager.js";
import type { StructuredLogger } from "../../tracing/index.js";
import type { KnownSecret } from "../../error-reporting/secret-detector.js";
import { isFusionWorkerSessionId } from "../../session/fusion-worker-session.js";
import {
  DEFAULT_FUSION_CLOUD_WORKERS,
  DEFAULT_FUSION_MAX_ORCHESTRATOR_TASKS_PER_TURN,
} from "../../config/llm-run-mode-config.js";
import { getConfig } from "../../config/index.js";
import { workerReplyAllowance } from "../../local-llm/server/worker-slots.js";
import type { ToolContext, ToolDefinition } from "../tool-registry.js";
import { lessonSourceIsRestricted } from "../../prompt/project-lessons-data.js";
import { recordRestrictedProjectLessonExposure } from "../../session/project-lesson-exposure.js";
import { plannedLessonMismatch, reviewerTaskLessons } from "./worker-project-lessons.js";
import { checkProjectDispatch, planCoverageGap, plannedCheckMismatch } from "./project-dispatch.js";
import { activeDecisionsOf, criteriaById, type AssignmentRow, type ProjectUpdate } from "../../session/session-project.js";
import {
  describeOversizedLocalTasks,
  localTaskSizeWarnings,
  oversizedLocalTasks,
  parseDelegateArgs,
} from "./delegate-args.js";
import {
  applyCheckOutcomes,
  applyContractFindings,
  CONTRACT_CHECKS_HELD,
  commandLineOf,
  inspectContractProvides,
  renderContractLine,
  runContractChecks,
  type ContractCheckOutcome,
  type ContractReport,
} from "./contract-checks.js";
import { checksWithExamples } from "./contract-example.js";
import {
  completedWaveNotes,
  contractForWave,
  dependencyWarnings,
  planWaves,
} from "./contract-waves.js";
import {
  clampTaskBudget,
  localTaskBudgetFloorMs,
  notStartedResult,
  runWorkerTasks,
  schedulerWaitNote,
  WORKER_BUDGET_CEILING_FACTOR,
  type WorkerRunnerDeps,
} from "./worker-runner.js";
import {
  checkWorkerFit,
  estimateRows,
  renderEstimateBlock,
} from "./worker-fit.js";
import { describeReplan, isOpenResult, renderReplanBlock } from "./replan.js";
import { LocalLegHealth } from "./local-leg-health.js";
import {
  LocalGrammarSmoke,
  describeFormatCheckRefusal,
  formatCheckTrip,
  type LocalGrammarProbeFor,
} from "./local-grammar-smoke.js";
import {
  renderMergeBlock,
  rebaseScope,
  rebaseText,
  runIsolatedWave,
  type KeptBranch,
  type MergeTaskSuggestion,
} from "./branch-merge.js";
import {
  applyPostMergeChecks,
  buildMergeGate,
  MergeGateState,
  type GateJudge,
} from "./merge-gate.js";
import {
  TaskTreeState,
  expandSplits,
  hasSplitProposal,
  renderSplitInstructions,
} from "./task-tree.js";
import { newFusionRunId, type FusionRunRecorder, type FusionRunStore } from "./run-checkpoint.js";
import { outcomeRowFor, type FusionOutcomeJournal } from "./outcome-journal.js";
import {
  outcomeLogPath,
  rowCostUsd,
  reviewOutcome,
  taskOutcomeRecord,
  criteriaOutcome,
  gamesOutcome,
  shotsOutcome,
  type TaskOutcomeContext,
  type FusionOutcomeSink,
  type MergeOutcome,
  type OutcomeLeg,
} from "./outcome-log.js";
import type { FusionTurnLedger } from "./turn-receipt.js";
import {
  planResume,
  readResumeRequest,
  type ResumePlan,
  resumeDirectorChange,
  resumeDirectorWarning,
} from "./run-resume.js";
import {
  applyJudgeVerdict,
  buildAcceptanceChecklist,
  judgeTask,
  redItems,
  hasRedFact,
  renderAcceptanceBlock,
  renderRetryFindings,
  renderReviewIssues,
  type AcceptanceItem,
  type JudgeFacts,
  type JudgeTarget,
  type JudgeVerdict,
} from "./judge.js";
import { evidencePath, renderAttemptEvidence, sha256Of, type AttemptRecord } from "./attempt-evidence.js";
import { renderCheckRunEvidence, renderExecutionEvidence } from "./execution-evidence.js";
import { sameMember } from "./member-identity.js";
import type { DelegateTask } from "./delegate-args.js";
import {
  ORCHESTRATOR_TASK_MODEL,
  allowedModels,
  legKey,
  resolveTaskLegs,
  unknownModels,
  type TaskLeg,
} from "./role-models.js";
import { provideSearchPaths, type ContractCheck, type DelegateContract } from "./contract.js";
import { checkSpecKey } from "./worker-self-check.js";
import { completionCostUsd, estimateUsageCostUsd } from "../../llm/provider/usage-cost.js";
import { applyTaskProfiles, shadowedBuiltinNote, type AppliedProfileReport } from "./task-profiles.js";
import {
  builtinAgentProfileSet,
  type AgentProfileSet,
} from "../../agent-profiles/index.js";
import {
  FusionTurnBudget,
  ORCHESTRATOR_TASK_CAP_INSTRUCTION,
  TURN_BUDGET_INSTRUCTION,
  TURN_COUNT_INSTRUCTION,
  formatUsd,
  orchestratorCapMessage,
  type TurnBudgetLimits,
  type TurnBudgetStop,
  type TurnCountLimits,
} from "./turn-budget.js";
import {
  FAILURE_BREAKER_INSTRUCTION,
  FanoutFailureBreaker,
  describeTrip,
  refusalFromTrips,
  type BreakerTrip,
} from "./failure-breaker.js";
import {
  delegateOutcome,
  fanoutSpend,
  formatDelegateOutput,
  taskSpendUsd,
  type WorkerPricing,
  type WorkerTaskResult,
} from "./worker-result.js";
import { runSyntaxPass, syntaxPassFiles, type SyntaxCheckRunner } from "./syntax-pass.js";
import { measuredTaskLegs, readRoutingHistory } from "./measured-routing.js";
import { collectTaskArtifactManifests } from "./artifact-manifest-tasks.js";
import { createCandidateIntegration, type CandidateIntegration, type CandidateIntegrationReport } from "./candidate-integration.js";
import { rebaseVerifyWorkspaceValue } from "../verify/rebase-verify-workspace.js";
import { isTooBroadScope, tooBroadWorkdirMessage } from "./scope-path.js";
import { withCandidateOutcome } from "./candidate-outcomes.js";
import { projectFusionArtifactEvidence } from "./artifact-evidence-output.js";
import { readFusionWorkerMeta } from "../../session/fusion-worker-session.js";
import { currentPolicyAllows, currentProviderPolicy, runWithProviderRole } from "../../llm/provider-policy.js";
import { resolveTeamRouting, teamContextFromConfig, type FusionTeamContext } from "./team-routing.js";
import { judgeTaskVision, pickVisionJudge, VISION_MAX_OUTPUT_TOKENS, type VisionDescribe } from "./vision-judge.js";
import { criteriaFactsFor, holdOnCriteria, taskCriteria, type VisionJudgements } from "./criteria-facts.js";
import { CHECK_LINT_PREFIX, checksWithoutCriteriaHint, describeCheckLintForApproval } from "./contract-check-lint.js";
import { readRunCriteria, writeRunChangedFiles, writeRunCriteriaFacts, type RunTaskReview } from "./run-criteria.js";
import { isPlaceholderReply, VERIFY_ONLY_UNCHANGED_NOTE } from "./declared-files.js";
import { createTaskPermitPool, type TaskPermit } from "./task-permits.js";
import { VERIFY_COPY_MAX_BYTES } from "../verify/verify-workspace-copy.js";
import { createContractCheckHold } from "./contract-check-hold.js";
import { contractChecksAllowedByEgress, withCheckRun, withContractCheckEgress, withContractCheckServices, type ContractCheckEgressRule } from "./contract-check-egress.js";
import { writeEvidenceReceipt, type ProjectReceiptWriter } from "../../session/project-receipts.js";
import { receiptHash } from "../../session/receipt-signing.js";
import type { CheckRunRecorder, ContractCheckRun, ContractCheckRunner } from "./contract-checks.js";
import type { ShellGuardPolicy } from "../os/shell-command-guard/index.js";
import type { CommandReadCheck, ReadTargetCheck } from "../read-scope/confine-reads.js";

export const FUSION_DELEGATE_TOOL = "fusion.delegate";

/**
 * How many `model: "orchestrator"` tasks run at once, at most (still
 * under `cloudWorkers`): each is a full turn on the strong leg.
 */
export const ORCHESTRATOR_TASK_MAX_WIDTH = 2;

export interface FusionDelegateDeps extends WorkerRunnerDeps {
  writeProjectReceipt?: ProjectReceiptWriter;
  receiptProjectFolder?: () => string | undefined;
  /**
   * Whether the fan-out asks the operator before it runs. Same seam as
   * every other dangerous tool: production passes `true`, tests pass
   * `false` to exercise the fan-out without a gate.
   */
  approvalRequired: boolean;
  /** Shared pre-exec verification policy; installed by runtime composition. */
  shellPolicy?: ShellGuardPolicy;
  /**
   * The registry's dispatch guard for one contract check, asked as a
   * `verify.run` call of the delegating session (issue #40): a refusal
   * (the folder's egress rule) turns that check red with its message
   * and it never runs (`contract-check-egress.ts`). Absent: no rule.
   */
  contractCheckEgress?: (spec: Record<string, unknown>, ctx: ToolContext) => Error | null;
  /**
   * The vision judge of visual contract checks (issue #40,
   * `vision-judge.ts`): whether a member's provider and model can take
   * images, the member `vision.describe` routes to now, and one describe
   * call through the registry's guarded provider. Absent: every visual
   * criterion is unverified.
   */
  visionJudge?: {
    sees(member: TeamMember): boolean;
    route(): TeamMember | null;
    describe: VisionDescribe;
  };
  checkCommandReads?: CommandReadCheck;
  checkReadTargets?: ReadTargetCheck;
  slotManager: Pick<SlotManager, "poolSize">;
  /** Live read — the operator can leave fusion mid-turn. */
  resolveRunMode: () => ResolvedRunMode;
  /**
   * The calling session's preferred worker (`metadata.fusionWorker`, set
   * by `--worker` or the composer), or null. A task that names no worker
   * runs on it before the team's default worker. Read per call.
   */
  currentWorker?: () => TeamMember | null;
  /**
   * The calling session's reviewer (`metadata.fusionReviewer`, issue #71):
   * a member that reviews every task it can serve before the team's pick,
   * `"none"` for no review in this chat, or null (the team picks). Read per call.
   */
  currentReviewer?: () => TeamMember | "none" | null;
  /** Does the worker leg keep KV-cache affinity per slot? */
  workerSupportsSlotAffinity: (providerId: string) => boolean;
  /** The fallback seam's `prepareLink`: warm the local backend once. */
  warmWorkerBackend: (providerId: string) => Promise<void>;
  /** Budget for the rendered result block. */
  outputCharCap: number;
  /**
   * `verify.syntax`'s checker (`verifySyntax`), which the delegate runs
   * itself on every green row's changed files after the waves
   * (`syntax-pass.ts`). Absent, no pass runs and no row claims one.
   */
  syntaxCheck?: SyntaxCheckRunner;
  logger: StructuredLogger;
  /**
   * The operator's request behind the turn now running on `sessionId`
   * (the orchestrator's session), quoted into every worker brief. The
   * runtime records it when the turn starts; absent, the briefs carry
   * only the orchestrator's instructions, as they did before.
   */
  resolveOriginalRequest?: (sessionId: string) => string | undefined;
  /** Opaque SHA256 of known configured request identity; undefined means insufficient provenance. */
  resolveRoutingIdentity?: (providerId: string) => string | undefined;
  /**
   * A provider's resolved default model (issue #98): a member ref's
   * `default` alias, or no model, stands for it when members are compared
   * (`member-identity.ts`). Absent, `default` equals only itself.
   */
  resolveDefaultModel?: (providerId: string) => string | undefined;
  /**
   * Pricing for the worker model on the worker leg, when any is known
   * (`resolveModelPricingFor`). Present, the status table header states
   * the fan-out's spend; a local leg resolves to nothing.
   */
  resolveWorkerPricing?: (
    providerId: string,
    modelId: string,
  ) => WorkerPricing | undefined;
  /**
   * The same pricing as `resolveWorkerPricing` minus any that came only
   * from the bundled models.dev snapshot (`verifiedAdmissionPricing`).
   * Only this gates the escalation's worst-case refusal and its re-run;
   * absent, `resolveWorkerPricing` is taken as verified.
   */
  resolveWorkerAdmissionPricing?: (
    providerId: string,
    modelId: string,
  ) => WorkerPricing | undefined;
  /**
   * The local leg's measured generation speed
   * (`LlamaServerClient.measuredTokensPerSecond`), read per fan-out so a
   * worker's time limit follows the machine's current load. Only
   * consulted for a slot-affine (local) leg; `null` before any
   * completion has been measured.
   */
  localTokensPerSecond?: () => number | null;
  /**
   * The per-turn caps' state (ATO-947), reset by the runtime at each
   * fusion turn's start. Absent, the tool keeps its own (whose clock
   * starts at the first fan-out). Only consulted when a cap is set.
   */
  turnBudget?: FusionTurnBudget;
  /** Runtime physical-request ledger already charges newly completed calls. */
  requestBudgetAccounting?: boolean;
  /** The orchestrator's priced spend so far this turn (`TurnUsageMeter.peekCostUsd`). */
  orchestratorTurnSpendUsd?: (sessionId: string) => number | undefined;
  /**
   * Where each run is checkpointed after every task and wave, and where
   * `resume` reads an unfinished one from (ATO-617). Absent: nothing is
   * written and `resume` is refused.
   */
  runCheckpoints?: FusionRunStore;
  /**
   * Where every finished worker task leaves one line of counts and
   * labels (ATO-949), the planner's memory of what works on this
   * machine (`outcome-journal.ts`, `llm.runMode.fusion.outcomeJournal`;
   * not the fusion outcome log `outcomeLog` below). Absent: nothing is
   * logged.
   */
  outcomeJournal?: Pick<FusionOutcomeJournal, "append">;
  /**
   * The agent's own state directory (`config.paths.stateDir`, usually
   * `~/.atomic-agent`). A fan-out whose write scope lies inside it is
   * refused before the operator is asked (ATO-1267): workers have no
   * business there, and one yes would cover every file the agent keeps
   * for itself. Absent (tests, embedders), no such check.
   */
  agentStateDir?: string;
  /**
   * Whether `providerId` is a subscription CLI whose own tools are only
   * confined, not off: the Codex CLI runs `-s read-only`, and its shell
   * can still read outside a worker's read scope. Such an orchestrator
   * leg is refused as a `model: "orchestrator"` target. Absent: none is.
   */
  cliToolsStayOn?: (providerId: string) => boolean;
  /**
   * The outcome log (`outcome-log.ts`): one line per task when the
   * fan-out finishes. Absent, nothing is written; the sink itself reads
   * `llm.runMode.fusion.outcomeLog`. A write failure never reaches the
   * fan-out.
   */
  outcomeLog?: FusionOutcomeSink;
  /** The turn receipt's per-turn tally (`turn-receipt.ts`). */
  turnLedger?: Pick<FusionTurnLedger, "noteFanout">;
  /**
   * The format check for one local leg (`local-grammar-smoke.ts`): one
   * short completion under the workers' grammar on that leg's server, or
   * `undefined` when nothing can ask it (a cloud leg, a second local
   * server). Absent: no leg is checked.
   */
  localGrammarProbeFor?: LocalGrammarProbeFor;
  /** Its verdicts across fan-outs; one per tool unless injected. */
  localGrammarSmoke?: LocalGrammarSmoke;
  /**
   * The subagent profiles a task may name (ATO-566), loaded for the
   * folder the fan-out runs in: built-ins, the user's, plugins' and the
   * project's trusted ones. Absent (tests, embedders), the built-ins.
   */
  resolveAgentProfiles?: (workingDir: string) => AgentProfileSet;
  /**
   * The fusion team (`llm.runMode.fusion.team`, issue #37) this call
   * routes by. Absent: read from the live config (`teamContextFromConfig`);
   * a function returning undefined: no team, routing as before.
   */
  resolveFusionTeam?: () => FusionTeamContext | undefined;
  /** The watch's timer (issue #43); tests tick it by hand. Absent, the global one. */
  watchClock?: WatchClock;
  /** The watch's first-tick jitter source (issue #43); tests pin it. Absent, `Math.random`. */
  watchRandom?: () => number;
}

/**
 * The scope directories that sit inside the agent's state directory,
 * or the state directory itself. A scope that merely contains it (the
 * home directory, say) is not refused here: the per-file trust-surface
 * guard already keeps config.json, .env, rules, hooks and plugins out
 * of any fan-out grant.
 */
export function scopeInsideStateDir(
  writeScope: readonly string[],
  stateDir: string | undefined,
): string[] {
  if (stateDir === undefined || stateDir.length === 0) return [];
  const root = resolvePath(stateDir);
  return writeScope.filter((dir) => isInside(root, resolvePath(dir)));
}

function error(
  output: string,
  details: Record<string, unknown> = {},
): CompressedToolResult {
  return compressToolResult({
    tool: FUSION_DELEGATE_TOOL,
    status: "error",
    output,
    details,
  });
}

/**
 * `fusion.delegate` — the orchestrator's fan-out.
 *
 * In fusion mode the active (cloud) model plans and this tool spends
 * the local ones: each task becomes an ephemeral worker session running
 * a turn pinned to the llama-server leg, several at a time, and the
 * orchestrator gets every reply back in one result. Cloud tokens pay
 * for the thinking, local tokens for the bulk.
 *
 * Three refusals, in order, all before any work starts:
 *
 *  1. **Not from inside a worker.** One level of fan-out keeps the cost
 *     model legible and the process bounded. `worker-tool-policy.ts`
 *     already hides the descriptor from a worker's catalog; this is the
 *     hard stop for a model that emits the name anyway.
 *  2. **Only while fusion is effective.** The mode is re-read live, not
 *     captured at boot: an operator who switches the active provider in
 *     Manage → LLM leaves fusion on the next read (§"Run modes"), and a
 *     tool that kept fanning out would be spending on a leg the operator
 *     just walked away from.
 *  3. **Only on valid args.** See `parseDelegateArgs`: the refusal
 *     names every problem of the call at once, so a slow local
 *     orchestrator regenerates once, not once per field.
 *
 * Once the call runs, its status summarises its tasks
 * (`details.outcome`): `ok` while any task delivered anything — partial
 * results are the whole value of a fan-out, and an orchestrator handed
 * a bare error learns nothing about which parts survived — and `error`
 * when none did: every task failed, was cancelled, never got a first
 * token, or ran out of time before its first step (`deliveredNothing`).
 * Per-task status lives in the output and in `details.tasks` either way.
 *
 * **Width is the model's call.** `args.maxWorkers` is honoured as asked;
 * `llm.runMode.fusion.workers` only fills in for a call that named
 * nothing. The orchestrator is the one that knows how divisible this
 * particular job is, and the `### fusion` guidance block tells it what
 * the machine can serve, so an operator-set number in a config file is
 * the wrong place to decide. The bounds that remain are physical: the
 * task count, and the server's request slots on a slot-affine leg.
 */
/**
 * What the operator reads before authorising a fan-out.
 *
 * The task titles, not a count: one prompt stands in for every write
 * these workers make, so the thing being approved has to be legible as
 * work, not as a number. The scope is stated last because it is the part
 * the answer actually grants.
 */
export function describeFanoutPreview(
  tasks: readonly { title: string }[],
  writeScope: readonly string[],
): string {
  const lines = tasks.map((task) => `  • ${task.title}`);
  const scope =
    writeScope.length > 0
      ? [
          `may write files and run commands in:`,
          ...writeScope.map((dir) => `  ${dir}`),
        ]
      : [
          `no writable directory could be derived from the briefs, so the`,
          `workers will still have to hand every write back up.`,
        ];
  return [...lines, "", ...scope].join("\n");
}

export function buildFusionDelegateTool(
  input: FusionDelegateDeps,
): ToolDefinition {
  // One per tool, so per runtime: a local server wedged by one fan-out's
  // cut-off worker is still wedged for the next fan-out (ATO-917).
  const deps: FusionDelegateDeps = {
    ...input,
    localLegHealth: input.localLegHealth ?? new LocalLegHealth(),
  };
  // Also per runtime: a leg's format verdict holds for every fan-out.
  const formatCheck = input.localGrammarSmoke ?? new LocalGrammarSmoke();
  const turnBudget = deps.turnBudget ?? new FusionTurnBudget();
  return {
    name: FUSION_DELEGATE_TOOL,
    description:
      "Delegate independent parts of the work to worker agents that run concurrently. You choose how many run at once with `maxWorkers`. A task that needs more room than the default can say so with `maxSteps` / `timeoutMs`; both are clamped to a multiple of the configured default and the result tells you when that happened. An optional `contract` (owners, provides, requires, checks; candidate-only immutable checkInputs) is prepended to every brief and checked after the fan-out. Give each `provides` entry a one-line `shape` (a signature, a return shape, what a field means): it is pasted into the brief of every worker that relies on it, and matching names is not matching meaning. For a function another task calls, also give an `example`: { call, expect, page? } — one small call (`PHYS.corners({x:0,y:0,w:2,h:2,a:0})`) and a JS condition over its result `r` (`r.length === 8 && 'w' in r[0]`); it is run once after the fan-out and a result that does not match fails the providing task. Browser code: set `page` to the HTML file that loads it (the call runs in that page's global scope); otherwise the provide's `in` file is loaded under node. A task may name a subagent `profile` (built-in: explore, review, research, read-only unless a user's or project's profile of the same name overrides them; or one the user defined): the worker gets that profile's instructions and tool list. Args: { tasks: [{ id, instructions, title?, deliverable?, files?, etaSeconds?, maxSteps?, timeoutMs?, role?, model?, profile? }] (1..16), maxWorkers?, contract? }. To continue a run cut off by a restart: { resume: runId, confirm?: [taskId] } and nothing else.",
    readonly: false,
    async run(rawArgs, ctx): Promise<CompressedToolResult> {
      // The project's run of an approved milestone (issue #39), set once
      // the fan-out is admitted and approved, recorded on the result.
      const admitted: FanoutAdmission = { milestoneId: null, started: false };
      const result = await runFanout(rawArgs, ctx, admitted);
      return withMilestoneRun(result, admitted);
    },
  };

  async function runFanout(
    rawArgs: Record<string, unknown>,
    ctx: ToolContext,
    admitted: FanoutAdmission,
  ): Promise<CompressedToolResult> {
      if (isFusionWorkerSessionId(ctx.sessionId)) {
        return error(
          "fusion.delegate is not available to a worker: do the task you were given and report back in your reply.",
          { reason: "recursive-delegation" },
        );
      }
      const mode = deps.resolveRunMode();
      // The private-copy limit for worktree isolation and candidate
      // staging: the same `tools.verify.maxCopyBytes` that bounds
      // `verify.run`'s workspace copy.
      const copyLimitBytes = getConfig().tools?.verify?.maxCopyBytes ?? VERIFY_COPY_MAX_BYTES;
      const gitObjectLimitBytes = getConfig().tools?.verify?.maxGitObjectBytes ?? VERIFY_COPY_MAX_BYTES;
      const workerProviderId = mode.workerProviderId;
      if (mode.effective !== "fusion" || workerProviderId === null) {
        return error(
          `fusion.delegate needs run mode "fusion" with a local worker provider; the run mode is "${mode.effective}". Do the work yourself.`,
          { reason: "not-fusion", effective: mode.effective },
        );
      }
      // A fan-out works in a project folder (issue #53): from a drive or
      // filesystem root or the home folder, every worker scope, copy and
      // merge would cover the person's whole disk or home.
      if (isTooBroadScope(ctx.workingDir)) {
        return error(tooBroadWorkdirMessage(ctx.workingDir, "fusion.delegate did not run: a fan-out"), {
          reason: "workdir-too-broad", workingDir: ctx.workingDir,
        });
      }
      // A resume (ATO-617) replays the cut-off run's own arguments: the
      // finished tasks are reported from its checkpoint, the rest run.
      const resumeRequest = readResumeRequest(rawArgs);
      if (typeof resumeRequest === "string") {
        return error(`fusion.delegate: ${resumeRequest}`, { field: "resume" });
      }
      if (mode.integration === "candidate" && resumeRequest !== null) {
        return error("candidate integration is explicitly non-resumable; inspect the retained patch and plan a fresh fan-out", { reason: "candidate-nonresumable" });
      }
      let resume: ResumePlan | undefined;
      let resumedFrom: ReturnType<FusionRunStore["load"]> = null;
      if (resumeRequest !== null) {
        resumedFrom = deps.runCheckpoints?.load(resumeRequest.runId) ?? null;
        if (resumedFrom === null || resumedFrom.sessionId !== ctx.sessionId) {
          return error(
            `fusion.delegate: there is no unfinished fusion run "${resumeRequest.runId}" in this session to resume. Plan the remaining work again instead.`,
            { reason: "resume-unknown", runId: resumeRequest.runId },
          );
        }
        if (deps.runCheckpoints!.isLive(resumedFrom)) {
          return error(
            `fusion.delegate: run "${resumeRequest.runId}" is still running; it cannot be resumed while it runs.`,
            { reason: "resume-live", runId: resumeRequest.runId },
          );
        }
        resume = planResume(resumedFrom, resumeRequest.confirm);
      }
      // The session's director now (issue #37): recorded in the run's
      // checkpoint, and compared with the one a resumed run started under.
      // The run mode's director, the one that actually leads this turn:
      // none on a pinned turn or without a usable director.
      const turnDirector = mode.director ?? null;
      const directorRef = turnDirector?.ref ?? null;
      const directorChange = resumedFrom === null ? null : resumeDirectorChange(resumedFrom, directorRef);
      if (directorChange !== null) {
        deps.logger.warn("fusion: resuming a run under a different director", {
          sessionId: ctx.sessionId, runId: resumedFrom!.runId, from: directorChange.from, to: directorChange.to,
        });
      }
      const delegateArgs = resumedFrom?.args ?? rawArgs;
      // A resume re-reads its approved contract: lint findings warn, never refuse (issue #110).
      const parsed = parseDelegateArgs(delegateArgs, resumedFrom === null ? {} : { storedContract: true });
      const plannedChecksHint = ctx.project?.plan?.rows.some((r) => (r.checks?.length ?? 0) > 0)
        ? " Keep planned checks exactly; update the plan with project.plan and obtain approval before changing them."
        : "";
      if (!parsed.ok) return error(`${parsed.error}${plannedChecksHint}`, { field: "tasks" });
      // A check's criteria are the approved brief's (issue #40): an id it
      // does not have could never be shown to the person as a fact.
      if (ctx.project?.brief?.status === "approved") {
        const known = criteriaById(ctx.project.brief);
        const unknown = [...new Set((parsed.contract?.checks ?? []).flatMap((c) => (c.criteria ?? []).filter((id) => !known.has(id))))];
        if (unknown.length > 0) {
          return error(
            `fusion.delegate did not run: contract.checks name criteria the approved brief does not have: ${unknown.join(", ")}; the brief's are ${[...known.keys()].join(", ") || "none"}${plannedChecksHint}`,
            { field: "contract" },
          );
        }
      }
      // Issue #110: task checks that prove no criterion of the approved
      // brief, one hint on the result and the approval line (never a refusal).
      const criteriaHint =
        ctx.project?.brief?.status === "approved"
          ? checksWithoutCriteriaHint(parsed.contract, ctx.project.brief.successCriteria.length)
          : null;
      const checkLintLines = [
        ...(parsed.contract?.warnings ?? []).filter((w) => w.startsWith(CHECK_LINT_PREFIX)),
        ...(criteriaHint === null ? [] : [criteriaHint]),
      ];
      // The fusion project's gate (issue #39), before anything starts.
      const projectVerdict = checkProjectDispatch(ctx.project, parsed.tasks.map((t) => t.id));
      if (projectVerdict.kind === "refuse") {
        return error(`fusion.delegate did not run: ${projectVerdict.message}`, { reason: "project-gate", gate: projectVerdict.reason });
      }
      const lessonsMismatch = plannedLessonMismatch(ctx.project, parsed.tasks, parsed.contract, ctx.workingDir, ctx.projectRef?.folder);
      if (lessonsMismatch !== null) return error(`fusion.delegate did not run: ${lessonsMismatch}`, { reason: "project-gate", gate: "plan-lessons-mismatch" });
      const checksMismatch = plannedCheckMismatch(ctx.project, parsed.tasks.map((t) => t.id), parsed.contract);
      if (checksMismatch !== null) return error(`fusion.delegate did not run: ${checksMismatch}`, { reason: "project-gate", gate: "plan-checks-mismatch" });
      if ((parsed.contract?.checkInputs?.length ?? 0) > 0 && mode.integration !== "candidate") {
        return error("contract.checkInputs requires candidate integration so the original check files can be frozen before workers", { reason: "check-inputs-require-candidate" });
      }
      // What the run spent before the restart counts toward this turn's
      // cap: a resume is the same run, not a fresh allowance. Once per run
      // and turn (issue #87): a retry after a refused or timed-out
      // approval, the checkpoint unchanged, adds nothing; new spend on the
      // checkpoint adds only its increment.
      const runAccounting = turnBudget.openRunAccounting(ctx.sessionId);
      if (resume !== undefined && resume.carriedSpendUsd > 0) {
        runAccounting.importCarried(resume.runId, resume.carriedSpendUsd);
      }

      // Labels, never guesses: the resolver's pin when it has one, the
      // provider id when it does not. Both legs are read from the same
      // live `mode` the fan-out is about to run on.
      const workerModel = mode.workerModel ?? workerProviderId;
      // Models by role and node (ATO-943): where each task runs, decided
      // before anything starts. A model name outside the allowed list
      // refuses the call; without `roles` every task is on the worker
      // leg, as before.
      const workerLegRef = { providerId: workerProviderId, model: workerModel };
      // The fusion team (issue #37): its workers are the models a task
      // may name, keyed by member; the director is the session's.
      const teamContext = deps.resolveFusionTeam === undefined ? teamContextFromConfig() : deps.resolveFusionTeam();
      const team =
        teamContext === undefined
          ? undefined
          : resolveTeamRouting(teamContext, {
              allows: currentPolicyAllows,
              currentDirector: () => turnDirector,
              ...(deps.currentWorker === undefined ? {} : { currentWorker: deps.currentWorker }),
              ...(deps.currentReviewer === undefined ? {} : { currentReviewer: deps.currentReviewer }),
              // Issue #71: no Codex reviewer (its own shell reads the disk) in a restricted chat.
              restricted: currentProviderPolicy() !== undefined,
              ...(deps.cliToolsStayOn === undefined ? {} : { cliToolsStayOn: deps.cliToolsStayOn }),
            });
      const teamTasks = team?.tasks;
      const director = team?.director ?? null;
      // Subagent profiles (ATO-566): applied before the legs are picked,
      // since a profile's model can set the task's role.
      let profileReports: AppliedProfileReport[] = [];
      if (parsed.tasks.some((t) => t.profile !== undefined)) {
        let profiles: AgentProfileSet;
        try {
          profiles =
            deps.resolveAgentProfiles?.(ctx.workingDir) ??
            builtinAgentProfileSet();
        } catch (err) {
          deps.logger.warn("fusion: loading agent profiles failed", {
            error: err instanceof Error ? err.message : String(err),
          });
          profiles = builtinAgentProfileSet();
        }
        if (profiles.diagnostics.length > 0) {
          deps.logger.warn("fusion: agent profile problems", {
            diagnostics: profiles.diagnostics,
          });
        }
        const profiled = applyTaskProfiles(
          parsed.tasks,
          profiles,
          allowedModels(workerLegRef, mode.roles, teamTasks),
        );
        if (!profiled.ok) {
          return error(profiled.error, { field: "tasks", reason: "unknown-profile" });
        }
        parsed.tasks.splice(0, parsed.tasks.length, ...profiled.tasks);
        profileReports = profiled.applied;
      }
      // `model: "orchestrator"`: a worker turn on the orchestrator's own
      // leg, under every worker rule. Counted against its own per-turn
      // cap (`maxOrchestratorTasksPerTurn`), since that leg is often an
      // unpriced subscription; `0` turns the target off.
      const orchestratorCap =
        mode.maxOrchestratorTasksPerTurn ??
        DEFAULT_FUSION_MAX_ORCHESTRATOR_TASKS_PER_TURN;
      // The tasks this call will run (issue #87): a resume's carried rows
      // and those awaiting the person's yes never start here. One set for
      // the orchestrator target, measured routing's remaining orchestrator
      // room, the admission check and the accounting when workers start.
      const notRunHere = new Set(
        resume === undefined ? [] : [...resume.carried, ...resume.needsConfirmation].map((r) => r.id),
      );
      if (
        orchestratorCap === 0 &&
        parsed.tasks.some((t) => t.model === ORCHESTRATOR_TASK_MODEL && !notRunHere.has(t.id))
      ) {
        return error(
          `validation: \`model: "orchestrator"\` is turned off here (llm.runMode.fusion.maxOrchestratorTasksPerTurn is 0). Send those tasks to a worker model: leave \`model\` out or name one from the \`### fusion\` list.`,
          { field: "tasks", reason: "orchestrator-target-off" },
        );
      }
      // A CLI leg whose own shell stays on (Codex: `-s read-only`) can
      // read past the worker's read scope; as a worker or role leg that
      // is the operator's pick, but this target is the planner's.
      // With a team the limit follows the session's director member.
      const orchestratorProviderId = director?.providerId ?? mode.orchestratorProviderId;
      const orchestratorCliToolsOn =
        orchestratorProviderId !== null &&
        deps.cliToolsStayOn?.(orchestratorProviderId) === true;
      if (
        orchestratorCliToolsOn &&
        parsed.tasks.some((t) => t.model === ORCHESTRATOR_TASK_MODEL)
      ) {
        return error(
          `validation: \`model: "orchestrator"\` is not available here: the orchestrator runs on a command-line agent whose own shell stays on (read-only, but not limited to the worker's read scope), so it cannot run a worker turn under the worker's rules. Send those tasks to a worker model: leave \`model\` out or name one from the \`### fusion\` list.`,
          { field: "tasks", reason: "orchestrator-target-cli-tools" },
        );
      }
      const orchestratorLegRef =
        orchestratorCliToolsOn
          ? undefined
          : director !== null
            ? {
                providerId: director.providerId,
                model: director.model,
                member: director.ref,
                ...(team!.pinsModel(director.providerId) ? { pinModel: director.model } : {}),
              }
            : mode.orchestratorProviderId === null
              ? undefined
              : {
                  providerId: mode.orchestratorProviderId,
                  model: mode.orchestratorModel ?? mode.orchestratorProviderId,
                };
      const modelProblem = unknownModels(
        parsed.tasks,
        workerLegRef,
        mode.roles,
        orchestratorLegRef,
        teamTasks,
      );
      if (modelProblem !== undefined) {
        return error(modelProblem, { field: "tasks", reason: "unknown-model" });
      }
      let taskLegs = resolveTaskLegs(
        parsed.tasks,
        workerLegRef,
        mode.roles,
        orchestratorLegRef,
        teamTasks,
      );
      const routing = mode.measuredRouting?.enabled === true
        ? measuredTaskLegs(parsed.tasks.filter((task) => resume === undefined || resume.rerun.includes(task.id)), taskLegs, workerLegRef, mode.roles, orchestratorLegRef, {
          records: deps.agentStateDir === undefined ? [] : readRoutingHistory(outcomeLogPath(deps.agentStateDir)),
          minSamples: mode.measuredRouting.minSamples,
          days: mode.measuredRouting.days,
          remainingOrchestrator: orchestratorCap - turnBudget.orchestratorTasks(ctx.sessionId) -
            [...taskLegs.entries()].filter(([id, leg]) => leg.orchestrator === true && !notRunHere.has(id)).length,
          attempted: (id) => turnBudget.attempts(ctx.sessionId, id) > 0,
          cliToolsStayOn: (provider) => deps.cliToolsStayOn?.(provider) === true,
          identityFor: (provider) => deps.resolveRoutingIdentity?.(provider),
          ...(teamTasks === undefined ? {} : { team: true }),
        }) : undefined;
      if (routing !== undefined) taskLegs = routing.legs;
      // Tasks sized past what a small local worker does well: run as
      // asked, never refused. Said on the approval line (before any
      // worker starts, when a person is asked) and on the result (the
      // orchestrator reads nothing in between).
      const orchestratorTaskIds = parsed.tasks
        .filter((t) => taskLegs.get(t.id)?.orchestrator === true)
        .map((t) => t.id);
      const actionableTaskCount = parsed.tasks.filter((t) => !notRunHere.has(t.id)).length;
      const actionableOrchestratorTaskIds = orchestratorTaskIds.filter((id) => !notRunHere.has(id));
      const taskIsLocal = (t: DelegateTask): boolean =>
        deps.workerSupportsSlotAffinity(
          taskLegs.get(t.id)?.providerId ?? workerProviderId,
        );
      const declaredInputs = parsed.contract?.inputs ?? [];
      const oversized = oversizedLocalTasks(parsed.tasks, taskIsLocal, declaredInputs);
      const sizeWarnings = localTaskSizeWarnings(parsed.tasks, taskIsLocal, declaredInputs);
      // The legs other than the worker leg, one per provider (per member
      // with a team: two models on one provider are two legs).
      const roleLegs = new Map<string, TaskLeg>();
      for (const leg of taskLegs.values()) {
        if (!leg.isWorkerLeg && !roleLegs.has(legKey(leg))) {
          roleLegs.set(legKey(leg), leg);
        }
      }
      const onLeg = (t: DelegateTask, leg: TaskLeg): boolean => {
        const own = taskLegs.get(t.id);
        return own?.isWorkerLeg === false && legKey(own) === legKey(leg);
      };
      // A team member on the worker leg asks for its model on every turn.
      const workerLegPin = [...taskLegs.values()].find((leg) => leg.isWorkerLeg && leg.pinModel !== undefined)?.pinModel;
      const roleProviderIds = [...new Set([...roleLegs.values()].map((leg) => leg.providerId))];

      // The turn's caps (ATO-947). Unset — the default — and nothing
      // below changes: no check, no extra signal, no timer.
      const limits: TurnBudgetLimits = {
        ...(mode.turnBudgetUsd === undefined ? {} : { usd: mode.turnBudgetUsd }),
        ...(mode.turnTimeBudgetMs === undefined
          ? {}
          : { timeMs: mode.turnTimeBudgetMs }),
      };
      const capped = limits.usd !== undefined || limits.timeMs !== undefined;
      const autoReplan = mode.autoReplan ?? 0;
      const budgetStop = (): TurnBudgetStop | undefined =>
        capped
          ? turnBudget.check(
              ctx.sessionId,
              limits,
              deps.orchestratorTurnSpendUsd?.(ctx.sessionId) ?? 0,
            )
          : undefined;
      const reached = budgetStop();
      if (reached !== undefined) {
        return error(
          `fusion.delegate did not run: ${reached.message}. ${TURN_BUDGET_INSTRUCTION}`,
          {
            reason: "turn-budget",
            kind: reached.kind,
            spentUsd: reached.spentUsd,
            elapsedMs: reached.elapsedMs,
          },
        );
      }
      // The turn's memory of earlier rounds (ATO-1406). Only with the
      // runtime's per-turn state: the tool's own fallback has no turn
      // boundary, and counts carried across turns would refuse forever.
      const tracksTurn = deps.turnBudget !== undefined;
      if (tracksTurn) {
        const priorTrip = refusalFromTrips(
          turnBudget.trips(ctx.sessionId),
          workerProviderId,
          roleProviderIds,
        );
        if (priorTrip !== undefined) {
          return error(
            `fusion.delegate did not run: earlier this turn ${describeTrip(priorTrip)}. Running the workers again would fail the same way. ${FAILURE_BREAKER_INSTRUCTION}`,
            {
              reason: "failure-breaker",
              blocker: priorTrip.blocker,
              signature: priorTrip.signature,
            },
          );
        }
        const countLimits: TurnCountLimits = {
          ...(mode.maxRoundsPerTurn === undefined
            ? {}
            : { rounds: mode.maxRoundsPerTurn }),
          ...(mode.maxTasksPerTurn === undefined
            ? {}
            : { tasks: mode.maxTasksPerTurn }),
        };
        const countStop = turnBudget.checkCounts(
          ctx.sessionId,
          { ...countLimits, orchestratorTasks: orchestratorCap },
          actionableTaskCount,
          actionableOrchestratorTaskIds.length,
        );
        if (countStop?.kind === "orchestrator-tasks") {
          return error(
            `fusion.delegate did not run: ${countStop.message}. ${ORCHESTRATOR_TASK_CAP_INSTRUCTION}`,
            { reason: "turn-count", kind: countStop.kind, cap: orchestratorCap },
          );
        }
        if (countStop !== undefined) {
          return error(
            `fusion.delegate did not run: ${countStop.message}. ${TURN_COUNT_INSTRUCTION}`,
            { reason: "turn-count", kind: countStop.kind },
          );
        }
      } else if (actionableOrchestratorTaskIds.length > orchestratorCap) {
        // No turn state to count across calls: the cap still holds per call.
        return error(
          `fusion.delegate did not run: ${orchestratorCapMessage(actionableOrchestratorTaskIds.length, 0, orchestratorCap)}. ${ORCHESTRATOR_TASK_CAP_INSTRUCTION}`,
          { reason: "turn-count", kind: "orchestrator-tasks", cap: orchestratorCap },
        );
      }

      // Before the pool is measured: warming replays the probes a cloud
      // boot deferred, and it is the `/props` round trip inside it that
      // resizes the slot pool from 1 to the daemon's real `--parallel`.
      // Reading `poolSize()` first would cap every fan-out at one worker
      // on a freshly booted cloud-active runtime.
      try {
        await deps.warmWorkerBackend(workerProviderId);
      } catch (err) {
        // Non-fatal: the completion itself will fail loudly a moment
        // later if the backend is really down, and that failure lands on
        // the task row instead of taking the whole call with it.
        deps.logger.warn("fusion: warming the worker backend failed", {
          providerId: workerProviderId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      for (const providerId of roleProviderIds) {
        try {
          await deps.warmWorkerBackend(providerId);
        } catch (err) {
          deps.logger.warn("fusion: warming a role model's backend failed", {
            providerId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const slotAffine = deps.workerSupportsSlotAffinity(workerProviderId);
      const poolSize = slotAffine
        ? Math.max(1, deps.slotManager.poolSize())
        : Number.POSITIVE_INFINITY;
      // The ORCHESTRATOR decides the width. It is the party that knows
      // what this fan-out is made of, and the `### fusion` block tells
      // it what the machine can serve, so `runMode.workers` is only the
      // default for a call that named nothing — never a ceiling on a
      // larger number the model asked for. What is left bounding it is
      // physical: you cannot run more workers than there are tasks, and
      // on a slot-affine leg you cannot run more than the server has
      // request slots (the rest would queue and evict each other's KV
      // cache rather than run).
      // A call that named no width on a LOCAL leg runs one worker at a
      // time unless the operator pinned `runMode.fusion.workers`: the
      // slots share one GPU, and the benchmark measured two local
      // workers at 2.6-2.9 tok/s each against 6.4 for one — parallel is
      // not faster there until a measurement says so, while a fan-out
      // that overflows the shared context loses every worker at once.
      // A cloud leg has no such pool and takes the configured default.
      const requested =
        parsed.maxWorkers ??
        (slotAffine ? (mode.workersPinned ? mode.workers : 1) : mode.workers);
      // Tasks a role model takes (ATO-943) are not this leg's to queue.
      const legTaskCount =
        roleLegs.size === 0
          ? parsed.tasks.length
          : parsed.tasks.filter((t) => taskLegs.get(t.id)?.isWorkerLeg !== false)
              .length;
      const wanted = Math.max(1, Math.min(requested, parsed.tasks.length));
      // A cloud leg has no slot pool, so nothing physical bounds the
      // width — only the bill. `cloudWorkers` is that bound: a
      // `maxWorkers` above it is clamped, and the result says so, since
      // the orchestrator is the party that can re-plan around it.
      const cloudCap = Number.isFinite(poolSize)
        ? Number.POSITIVE_INFINITY
        : (mode.cloudWorkers ?? DEFAULT_FUSION_CLOUD_WORKERS);
      const workerLegMaxWorkers = Math.max(1, Math.min(wanted, poolSize, cloudCap));
      const roleLegWidth = (leg: TaskLeg, count: number): number =>
        Math.max(1, Math.min(count,
          deps.workerSupportsSlotAffinity(leg.providerId) ? 1 : (mode.cloudWorkers ?? DEFAULT_FUSION_CLOUD_WORKERS),
          leg.orchestrator === true ? ORCHESTRATOR_TASK_MAX_WIDTH : Number.POSITIVE_INFINITY));
      // The call's ceiling spans all active legs; an unused main local
      // pool cannot serialize tasks assigned exclusively to cloud roles.
      // With no width named or pinned, every slot-affine (local) leg —
      // the main one and any local role leg — shares the one-worker
      // default above: they draw on the same GPU, so a local role leg
      // beside the local main leg must not double it.
      const shareLocalCeiling = parsed.maxWorkers === undefined && !mode.workersPinned;
      let localWidth = slotAffine ? Math.min(legTaskCount, workerLegMaxWorkers) : 0;
      let cloudWidth = slotAffine ? 0 : Math.min(legTaskCount, workerLegMaxWorkers);
      for (const leg of roleLegs.values()) {
        const count = parsed.tasks.filter((t) => onLeg(t, leg)).length;
        if (count === 0) continue;
        if (deps.workerSupportsSlotAffinity(leg.providerId)) localWidth += roleLegWidth(leg, count);
        else cloudWidth += roleLegWidth(leg, count);
      }
      const capacity = cloudWidth + (shareLocalCeiling ? Math.min(1, localWidth) : localWidth);
      // A named `maxWorkers` is the call's explicit ceiling. A call that
      // named none is bounded by the active legs alone: the local default
      // of one worker (or `runMode.workers`) is the MAIN leg's width
      // above, never a ceiling on role-model or orchestrator legs.
      const maxWorkers = Math.max(1, Math.min(parsed.maxWorkers === undefined ? capacity : wanted, capacity));
      const permits = createTaskPermitPool(maxWorkers);
      // The shared local ceiling: a local leg takes its local permit
      // first, then a call-wide one, so a task waiting for the GPU never
      // holds a call-wide permit a cloud task could use.
      const localPermits = createTaskPermitPool(1);
      const acquireLocalPermit = async (signal: AbortSignal): Promise<TaskPermit | undefined> => {
        const local = await localPermits.acquire(signal);
        if (local === undefined) return undefined;
        const call = await permits.acquire(signal);
        if (call === undefined) {
          local.release();
          return undefined;
        }
        return { waitMs: local.waitMs + call.waitMs, release: () => { call.release(); local.release(); } };
      };
      const acquirePermitFor = (local: boolean): ((signal: AbortSignal) => Promise<TaskPermit | undefined>) =>
        shareLocalCeiling && local ? acquireLocalPermit : permits.acquire;
      // Binding is judged on the MAIN leg alone, whatever role legs run
      // beside it: its own tasks against its own width. The cloud cap
      // binds when it, not the requested width, cut that leg down…
      const mainWanted = Math.max(1, Math.min(requested, legTaskCount));
      const cloudCapIsBinding =
        legTaskCount > 0 && !Number.isFinite(poolSize) &&
        workerLegMaxWorkers < mainWanted && workerLegMaxWorkers === cloudCap;
      // …and the pool held it down when it ran fewer at a time than the
      // leg had work for and the slot count is what set that width —
      // whether the orchestrator asked for a wider number or simply had
      // more tasks than the machine has slots. A default of one worker
      // on a larger pool is not the pool's doing.
      const poolIsBinding =
        legTaskCount > 0 && Number.isFinite(poolSize) &&
        workerLegMaxWorkers < legTaskCount && workerLegMaxWorkers === poolSize;

      const orchestratorModel =
        director?.model ??
        mode.orchestratorModel ??
        mode.orchestratorProviderId ??
        mode.primaryProviderId;

      // The orchestrator claims its own call before the workers start
      // talking. Everything between this line and the closing one below
      // is worker work on the local leg; this is the runtime's only
      // honest, zero-cost place to say so — the parent turn's other
      // steps are served through the fallback chain and may not have run
      // on `orchestratorModel` at all, so they are deliberately left
      // unlabelled rather than attributed on a guess.
      deps.emitEvent(ctx.sessionId, {
        type: "fusion_worker",
        taskId: FUSION_DELEGATE_TOOL,
        title: `${parsed.tasks.length} task${parsed.tasks.length === 1 ? "" : "s"}`,
        phase: "tool",
        role: "orchestrator",
        model: orchestratorModel,
        tool: FUSION_DELEGATE_TOOL,
      });

      // One question for the whole fan-out, asked before a single worker
      // starts. A worker has no operator to ask — that is what made the
      // mode unusable below full trust, with every write refused and the
      // orchestrator left as the only party able to act — so the
      // operator is asked here instead, once, with the task list and the
      // directory in front of them.
      const analysedScope = analyseFanoutScope(parsed.tasks, ctx.workingDir);
      let writeScope = analysedScope.scope;
      // Never into the agent's own state directory (ATO-1267).
      const intoState = scopeInsideStateDir(writeScope, deps.agentStateDir);
      if (intoState.length > 0) {
        return error(
          `fusion.delegate did not run: the tasks would write in the agent's own state directory (${intoState.join(", ")}). ` +
            "Workers cannot write there. Name a project directory for the work instead; " +
            "if the user really wants a change to the agent's own files, tell them, since only they can make it.",
          { reason: "agent-state-dir", scope: intoState },
        );
      }
      // A local leg that cannot produce the tool-call format is found out
      // here, with one short completion, before the person is asked and
      // before a worker spends its time on it (local-grammar-smoke.ts).
      // Never a cloud leg: only a slot-affine leg with a probe is asked.
      // The servers this fan-out will load: while it runs, a check
      // there (another session's fan-out) is skipped, not queued.
      const checkedServers = new Set<string>();
      if (mode.localFormatCheck !== false && deps.localGrammarProbeFor !== undefined) {
        const localLegs = new Map<string, string>();
        if (slotAffine && legTaskCount > 0) localLegs.set(workerProviderId, workerModel);
        for (const leg of roleLegs.values()) {
          if (deps.workerSupportsSlotAffinity(leg.providerId)) localLegs.set(leg.providerId, leg.model);
        }
        for (const [providerId, model] of localLegs) {
          const probe = deps.localGrammarProbeFor(providerId, {
            orchestratorProviderId: mode.orchestratorProviderId ?? mode.primaryProviderId,
          });
          if (probe === undefined) continue;
          checkedServers.add(probe.server);
          const checked = await formatCheck.check(probe, {
            sessionId: ctx.sessionId,
            leg: providerId,
            signal: ctx.signal,
          });
          deps.logger.info("fusion: local format check", {
            providerId,
            verdict: checked.kind,
            ...("cached" in checked ? { cached: checked.cached } : {}),
            ...(checked.kind === "inconclusive" ? { reason: checked.reason } : {}),
            ...(checked.kind === "skipped" ? { why: checked.why } : {}),
          });
          if (checked.kind === "fail") {
            const trip = formatCheckTrip(providerId);
            if (tracksTurn) turnBudget.noteTrip(ctx.sessionId, trip);
            return error(describeFormatCheckRefusal(trip, checked.error, model), {
              reason: "failure-breaker",
              blocker: true,
              signature: trip.signature,
              formatCheck: true,
            });
          }
        }
      }

      // A local worker's time limit is sized from the machine's measured
      // speed (F19); a cloud leg has no such measurement and keeps the
      // configured ceiling.
      const localTokensPerSecond = Number.isFinite(poolSize)
        ? (deps.localTokensPerSecond?.() ?? null)
        : null;
      // Will each task's stated output fit its time limit at that speed
      // (ATO-1363)? Advisory only: every task is dispatched. One over its
      // limit gets a warning on its row; one no allowed limit could hold
      // also gets a note to the planner in the result. Without a measured
      // speed, or without estimates, nothing happens.
      const fit = checkWorkerFit({
        tasks: parsed.tasks.filter(
          (t) => taskLegs.get(t.id)?.isWorkerLeg !== false,
        ),
        tokensPerSecond: localTokensPerSecond,
        concurrency: maxWorkers,
        budgetMsFor: (t) =>
          Math.max(
            clampTaskBudget(t.timeoutMs, mode.workerTimeoutMs).value,
            localTaskBudgetFloorMs(mode.workerTimeoutMs),
          ),
        maxBudgetMs: mode.workerTimeoutMs * WORKER_BUDGET_CEILING_FACTOR,
      });
      // A turn is one job. An orchestrator that reviews and re-delegates
      // runs five fan-outs to build one library, and asking the same
      // question five times is attrition, not consent. The operator's
      // answer stands for the rest of the turn as long as later fan-outs
      // stay inside the directories it named; one reaching somewhere new
      // asks again.
      //
      // Except after the user declined a file in those directories this
      // turn: the workers would write it unasked under the standing yes,
      // so re-delegating a declined write is asked about again.
      // Who reviews each task (issue #38, #71, #74), resolved before the
      // prompt: the approved plan's yes names each task's reviewer too.
      const judgeTarget = mode.judge ?? null;
      const teamReview =
        teamContext === undefined
          ? undefined
          : {
              // The chat's own choice (issue #71) wins: "none" is off, a
              // reviewer it chose is on; else the team's setting.
              on: team?.reviewOff === true
                ? false
                : team?.reviewChosen === true || reviewEnabled(teamContext.team, judgeTarget === null ? "off" : "on"),
              passes: reviewPassesOf(teamContext.team),
            };
      const taskMember = (taskId: string): TeamMember => {
        const leg = taskLegs.get(taskId);
        const providerId = leg?.providerId ?? workerProviderId;
        const model = leg === undefined || leg.isWorkerLeg ? workerModel : leg.model;
        return { providerId, model, ref: leg?.member ?? `${providerId}:${model}` };
      };
      // The approved plan row's reviewer reviews its task (issue #74),
      // whoever set it: the person at the plan gate (`reviewerByPerson`)
      // or the director's draft the person approved. It wins over the
      // chat's reviewer (issue #71), the team's pick and `team.review`,
      // which stay the default for a task outside the plan. A row's null
      // is "no review" when a reviewer could have been named (the person
      // chose it, or the team lists reviewers); without team reviewers it
      // only says no team reviewer, and `judgeProvider` still judges. A
      // reviewer that can no longer review here (not a team reviewer this
      // folder can use now, or now the task's worker) falls back to the
      // default, so the plan no longer stands for the prompt, and the
      // prompt and the task's row say why.
      const approvedRows = new Map<string, AssignmentRow>();
      if (projectVerdict.kind === "admit" && ctx.project?.plan?.status === "approved") {
        const planned = new Set(projectVerdict.planned);
        for (const r of ctx.project.plan.rows) if (planned.has(r.taskId)) approvedRows.set(r.taskId, r);
      }
      const planReviewers = new Map<string, string | null>();
      for (const [id, r] of approvedRows) {
        if (r.reviewer !== null || r.reviewerByPerson === true || team?.hasReviewers === true) planReviewers.set(id, r.reviewer);
      }
      const unusablePlanReviewers = new Map<string, string>();
      const taskReviewers = new Map<string, { member: TeamMember | null; fromPlan: boolean }>();
      /** The team member that reviews the task (null: none; `judgeProvider` may still judge a default task). */
      const taskReviewerOf = (taskId: string): { member: TeamMember | null; fromPlan: boolean } => {
        let found = taskReviewers.get(taskId);
        if (found === undefined) {
          const picked = planReviewers.get(taskId);
          const usable =
            picked === undefined || picked === null
              ? undefined
              : (team?.reviewers ?? []).find(
                  (m) => sameMember(m.ref, picked, deps.resolveDefaultModel) && !sameMember(m.ref, taskMember(taskId).ref, deps.resolveDefaultModel),
                );
          if (picked === null || usable !== undefined) found = { member: usable ?? null, fromPlan: true };
          else {
            if (picked !== undefined) {
              unusablePlanReviewers.set(
                taskId,
                sameMember(picked, taskMember(taskId).ref, deps.resolveDefaultModel)
                  ? "it is now the task's worker"
                  : "it is not a team reviewer this folder's policy allows and that can answer now",
              );
            }
            found = {
              member: teamReview?.on === false || team?.hasReviewers !== true ? null : team.reviewerFor(taskMember(taskId)),
              fromPlan: false,
            };
          }
          taskReviewers.set(taskId, found);
        }
        return found;
      };
      for (const t of parsed.tasks) taskReviewerOf(t.id);
      /** The team reviewer that would review the task here; null: none (no review runs without a completion seam for it). */
      const reviewerRefOf = (taskId: string): string | null =>
        deps.escalationComplete === undefined ? null : (taskReviewerOf(taskId).member?.ref ?? null);
      /** Why the reviewer that would run is not the approved row's, or undefined when it is. */
      const planReviewerNote = (taskId: string): string | undefined => {
        const row = approvedRows.get(taskId);
        if (row === undefined) return undefined;
        const runs = reviewerRefOf(taskId);
        if (sameMember(row.reviewer, runs, deps.resolveDefaultModel)) return undefined;
        const instead = runs === null ? "no team reviewer reviews it" : `${runs} reviews it instead`;
        if (row.reviewer === null) return `the plan has no review for it, but ${runs} would review it`;
        const why = unusablePlanReviewers.get(taskId) ?? "no review can run here";
        return `plan reviewer ${row.reviewer} is no longer usable here (${why}); ${instead}`;
      };
      const planReviewerNotes = new Map(
        parsed.tasks.flatMap((t) => {
          const note = planReviewerNote(t.id);
          return note === undefined ? [] : [[t.id, note] as const];
        }),
      );
      const declinedInScope =
        deps.approvals.hasDeclinedUnder?.(ctx.sessionId, writeScope) ?? false;
      // Nor after outside content (`agent.taintReview`): the standing yes
      // was given before the text that may now be steering the fan-out.
      // An approved project plan (issue #39) is the person's yes to these
      // exact tasks on these workers in this folder; anything else asks.
      // Why the approved plan does not stand for this fan-out, when it does not (issue #104).
      const planGap: string | undefined =
        projectVerdict.kind !== "admit" || ctx.project === undefined
          ? "no approved project plan covers it"
          : projectVerdict.unplanned.length > 0
            ? `task${projectVerdict.unplanned.length === 1 ? "" : "s"} ${projectVerdict.unplanned.join(", ")} ${projectVerdict.unplanned.length === 1 ? "is not a row" : "are not rows"} of the plan`
            // A brief naming a path the scope cannot grant (unresolvable
            // here, or a root/home directory) writes outside the folder the
            // plan was approved for, even though the scope leaves it out.
            : analysedScope.namesUngrantedPath
              ? "a brief names a path outside the folder the plan was approved for"
              : planCoverageGap(
                  ctx.project,
                  parsed.tasks.map((t) => t.id),
                  (id) => {
                    const leg = taskLegs.get(id);
                    return leg === undefined ? `${workerProviderId}:${workerModel}` : (leg.member ?? `${leg.providerId}:${leg.model}`);
                  },
                  reviewerRefOf,
                  writeScope,
                  [ctx.workingDir],
                  deps.resolveDefaultModel,
                );
      const planApproved = planGap === undefined;
      const turnGrantCovers =
        deps.approvals.fanoutScopes?.turnGrantCovers(ctx.sessionId, writeScope) ?? false;
      const alreadyApproved =
        !declinedInScope &&
        !(deps.approvals.holdsForOutsideContent?.(ctx.sessionId, "fusion_fanout") ?? false) &&
        (planApproved || turnGrantCovers);
      try {
        if (!alreadyApproved) {
          // A yes from a person who was shown this fan-out is their newer
          // answer for the files they declined in its directories; one
          // the level gave is not, and those files stay declined.
          const asksPerson =
            declinedInScope &&
            deps.approvalRequired &&
            (deps.approvals.wouldPrompt?.(ctx.sessionId, "fusion_fanout", {
              tool: FUSION_DELEGATE_TOOL,
              affectedResources: [...writeScope],
            }) ??
              false);
          await requireApproval(
            {
              approvals: deps.approvals as ApprovalGate,
              approvalRequired: deps.approvalRequired,
            },
            {
              sessionId: ctx.sessionId,
              tool: FUSION_DELEGATE_TOOL,
              category: "fusion_fanout",
              reason: `${parsed.tasks.length} task${parsed.tasks.length === 1 ? "" : "s"} to ${maxWorkers} worker${maxWorkers === 1 ? "" : "s"} on ${workerModel}${
                roleLegs.size === 0
                  ? ""
                  : ` and ${[...roleLegs.values()].map((l) => l.model).join(", ")}`
              }${tracksTurn ? describeTurnCounts(turnBudget.counts(ctx.sessionId), actionableTaskCount, mode) : ""}${describeOversizedLocalTasks(oversized)}${describeCheckLintForApproval(checkLintLines)}${
                planReviewerNotes.size === 0
                  ? ""
                  : `; ${[...planReviewerNotes].map(([id, note]) => `task ${id}: ${note}`).join("; ")}`
              }`,
              preview: describeFanoutPreview(parsed.tasks, writeScope),
              affectedResources: [...writeScope],
            },
            ctx.signal,
          );
          if (asksPerson) {
            deps.approvals.forgetDeclinedUnder?.(ctx.sessionId, writeScope);
          }
        }
        // The plan's yes covers its own tasks only: a fan-out it admitted
        // without asking grants nothing for the rest of the turn.
        if (!alreadyApproved || turnGrantCovers) {
          deps.approvals.fanoutScopes?.grantForTurn(ctx.sessionId, writeScope);
        }
        if (projectVerdict.kind === "admit") admitted.milestoneId = projectVerdict.milestoneId;

      } catch (err) {
        // In a project, say why the plan did not stand for it and how to send it so it does (issue #104).
        const offPlan = projectVerdict.kind === "admit" && planGap !== undefined && ctx.project?.plan?.status === "approved"
          // Only what broke coverage: no task id to borrow, no route around the approval (issue #104 review).
          ? `This fan-out needs the person's approval: the approved plan does not cover it (${planGap}). `
          : "";
        // The user's own no already says what happened and what to do,
        // and so does a repeat of one they declined earlier in the turn.
        if (
          err instanceof ApprovalDeniedError &&
          (err.byUser || err.declinedEarlier)
        ) {
          // First: the summary is clipped, and this is what the director can act on.
          return error(`${offPlan}${err.message}`, {
            reason: "fan-out-denied",
            deniedByUser: true,
            ...(offPlan === "" ? {} : { planGap }),
          });
        }
        return error(
          `${offPlan}the fan-out was not approved: ${err instanceof Error ? err.message : String(err)}`,
          { reason: "fan-out-denied", ...(offPlan === "" ? {} : { planGap }) },
        );
      }

      const candidateOriginalDir = ctx.workingDir;
      const receiptWriter = ctx.incognito ? undefined : deps.writeProjectReceipt;
      const writeReceipt = (kind: "check-run-record" | "artifact-manifest", payload: () => Record<string, unknown>): void => {
        if (receiptWriter === undefined) return;
        writeEvidenceReceipt(receiptWriter, message => deps.logger.warn(message), {
          id: ctx.sessionId,
          workingDir: deps.receiptProjectFolder?.() ?? candidateOriginalDir,
          ...(ctx.projectRef === undefined ? {} : { projectRef: ctx.projectRef }),
        }, kind, () => ({
          ...payload(),
          ...(admitted.milestoneId === null ? {} : { milestoneId: admitted.milestoneId }),
          ...(admitted.runId === undefined ? {} : { runId: admitted.runId }),
        }));
      };
      const recordCheckRun: CheckRunRecorder | undefined = receiptWriter === undefined
        ? undefined
        : (check, record, ok) => writeReceipt("check-run-record", () => ({
            kind: check.kind ?? "command",
            ...(check.task === undefined ? {} : { task: check.task }),
            definitionHash: receiptHash(JSON.parse(JSON.stringify(check))),
            recordHash: receiptHash(record),
            outputHash: receiptHash(record.output),
            exitCode: record.exitCode,
            ok,
          }));
      let candidate: CandidateIntegration | undefined;
      const completedCandidateRows = new Map<string, WorkerTaskResult>();
      const candidateWorkerRuns = new Map<string, number>();
      let candidateOutcomesRecorded = false;
      let completedCandidateReport: CandidateIntegrationReport | undefined;
      let terminalTaskCount = 0;
      // Tasks the call meant to review that ended with no verdict, and why (issue #95).
      let noReviewVerdict: Array<{ taskId: string; reason: string }> = [];
      let runReviews: RunTaskReview[] = [];
      let runMeta: () => { ran: readonly string[]; judging: boolean; passedChecks?: readonly Record<string, unknown>[] } | undefined = () => undefined;
      let secretCollectionFailed = false;
      const collectKnownSecrets = (): readonly KnownSecret[] | undefined => {
        if (secretCollectionFailed) throw new Error("Secret metadata unavailable");
        try { return deps.knownSecrets?.(); }
        catch { secretCollectionFailed = true; throw new Error("Secret metadata unavailable"); }
      };
      let recordCandidateInterruption: ((report: CandidateIntegrationReport) => void) | undefined;
      // The contract's checks as the director wrote them, before a
      // candidate run rebases them into its private workspace: what a run
      // keeps for later fix rounds (issue #106 review).
      const checksAsWritten = parsed.contract?.checks ?? [];
      try {
      if (mode.integration === "candidate") {
        if (writeScope.some(path => !isInside(resolvePath(candidateOriginalDir), resolvePath(path)))) {
          return error("candidate integration requires all declared write scopes inside the current project", { reason: "candidate-outside-project" });
        }
        try {
          const remaining = capped ? turnBudget.timeLeftMs(ctx.sessionId, limits) : undefined;
          const signal = remaining === undefined ? ctx.signal : AbortSignal.any([ctx.signal, AbortSignal.timeout(Math.max(0, remaining))]);
          candidate = await createCandidateIntegration(candidateOriginalDir, { signal, maxCopyBytes: copyLimitBytes, maxGitObjectBytes: gitObjectLimitBytes, checkInputs: parsed.contract?.checkInputs });
        } catch (err) {
          return error(`candidate integration could not stage a private workspace: ${err instanceof Error ? err.message : String(err)}`, { reason: "candidate-staging-failed", nonResumable: true });
        }
        const roots = [candidateOriginalDir, candidateOriginalDir.replace(/\\/g, "/")];
        parsed.tasks = rebaseCandidateValue(parsed.tasks, roots, candidate.dir);
        if (parsed.contract !== undefined) {
          const originalInputs = parsed.contract.inputs;
          const originalCheckInputs = parsed.contract.checkInputs;
          const originalChecks = parsed.contract.checks;
          parsed.contract = rebaseCandidateValue(parsed.contract, roots, candidate.dir);
          // Check plans have stricter literal-path semantics than worker prose.
          if (originalChecks !== undefined) parsed.contract.checks = rebaseVerifyWorkspaceValue(originalChecks, candidateOriginalDir, candidate.dir);
          // Resolve input identity independently of the prose rewriter: on
          // Windows the original root may use any case. Keep only the
          // declared suffix so generated temp prefixes cannot become globs.
          if (originalInputs !== undefined) parsed.contract.inputs = originalInputs.map(path => {
            try {
              const absolute = resolveUserPath(path, candidateOriginalDir);
              return isInside(candidateOriginalDir, absolute) ? relative(candidateOriginalDir, absolute) : path;
            } catch { return path; }
          });
          if (originalCheckInputs !== undefined) parsed.contract.checkInputs = originalCheckInputs.map(path => {
            const absolute = resolveUserPath(path, candidateOriginalDir);
            return relative(candidateOriginalDir, absolute);
          });
        }
        writeScope = rebaseScope(writeScope, roots, candidate.dir);
        ctx = { ...ctx, workingDir: candidate.dir, ...(ctx.readRoots === undefined ? {} : { readRoots: ctx.readRoots.map(path => rebaseText(path, roots, candidate!.dir)) }) };
      }
      // The orchestrator's brief is a summary, and summaries were thin
      // enough that workers built the wrong thing or scavenged the disk
      // for the missing spec. Every worker also gets what was asked.
      // A resumed run keeps the request it was started for: this turn's
      // own message is the person's "continue", not the job.
      const request =
        resumedFrom?.originalRequest ??
        deps.resolveOriginalRequest?.(ctx.sessionId);
      const originalRequest = request === undefined || candidate === undefined ? request : rebaseText(request, [candidateOriginalDir, candidateOriginalDir.replace(/\\/g, "/")], candidate.dir);
      // The approved project brief (issue #39): every worker's brief says
      // what is built and its success criteria, and every reviewer's
      // judge brief the criteria. A resumed run reads the same project.
      const approvedBrief = ctx.project?.brief?.status === "approved" ? ctx.project.brief : undefined;
      const projectBrief = approvedBrief === undefined
        ? undefined
        : (() => {
            // Issue #112: the active decisions go with the criteria to every worker and reviewer.
            const decisions = activeDecisionsOf(ctx.project!).map((d) => `${d.id}: ${d.text}`);
            // Issue #146: each task's cited backlog items, by plan task id (the worker reads them framed as data).
            const items = new Map((ctx.project!.backlog ?? []).map((b) => [b.id, b]));
            const backlogByTask: Record<string, string[]> = {};
            for (const r of ctx.project!.plan?.rows ?? []) {
              const cited = (r.backlog ?? []).flatMap((id) => {
                const b = items.get(id);
                return b === undefined ? [] : [`${b.id}: ${b.title}${b.note === undefined ? "" : ` (${b.note})`}`];
              });
              if (cited.length > 0) backlogByTask[r.taskId] = cited;
            }
            return {
              what: approvedBrief.what,
              successCriteria: approvedBrief.successCriteria.map((c) => c.text),
              ...(decisions.length === 0 ? {} : { decisions }),
              ...(Object.keys(backlogByTask).length === 0 ? {} : { backlogByTask }),
            };
          })();
      // The criteria a task's checks name are acceptance items, ruled by
      // facts and the vision judge (issue #40).
      const briefCriteria = approvedBrief === undefined ? undefined : criteriaById(approvedBrief);
      // The texts a run's facts are tagged with (issue #87): the criteria
      // its checks were written for. A resume replays the checkpoint's own
      // checks, so it keeps the checkpoint's texts (none in an older file),
      // never this turn's brief.
      const factCriteria: ReadonlyMap<string, { text: string }> | undefined =
        resumedFrom === null
          ? briefCriteria
          : resumedFrom.criteria === undefined
            ? undefined
            : new Map(resumedFrom.criteria.map((c) => [c.id, { text: c.text }]));
      // The reply cap the local pool was divided by (`workerSlotFootprint`
      // sizes each worker's reply at `workerReplyAllowance`, not at the raw
      // `completionMaxTokens`). A cap above that allowance is sent as the
      // workers' own, so no worker can write past its share of the shared
      // context; an operator's `workerMaxOutputTokens` still wins, a cap
      // at or below the allowance changes nothing, and a cloud leg (no
      // pool, `poolSize` infinite) is never capped here.
      const localReplyCap = getConfig().localModels.completionMaxTokens;
      const workerMaxOutputTokens =
        mode.workerMaxOutputTokens ??
        (Number.isFinite(poolSize) &&
        localReplyCap > workerReplyAllowance(localReplyCap)
          ? workerReplyAllowance(localReplyCap)
          : undefined);

      // The order the contract imposes (F45): a task that requires what
      // a sibling provides runs in a later wave than that sibling, so it
      // is not sent to wait for a file that does not exist yet. Without
      // a contract, or without a satisfiable `requires`, the plan is one
      // wave holding every task — the fan-out as it always ran.
      const plan = planWaves(
        parsed.tasks.map((t) => t.id),
        parsed.contract,
      );
      const ordered = plan.dependencies.size > 0;
      // What the waves add to the contract's own warnings: a cycle, and
      // every provider that had not delivered when its dependent ran.
      // Each wave's block carries everything known so far; the result's
      // `contract:` line carries all of it.
      const waveWarnings: string[] = [
        ...(plan.cycle === undefined ? [] : [plan.cycle]),
        ...(criteriaHint === null ? [] : [criteriaHint]),
      ];
      const dependencyCheckOutcomes = new Map<number, ContractCheckOutcome>();
      const verifiedNoChangesProviders = new Set<string>();

      // A cap reached mid-fan-out stops what is running and starts
      // nothing more; the rows say why.
      const workerPricing = deps.resolveWorkerPricing?.(
        workerProviderId,
        workerModel,
      );
      const budgetAbort = new AbortController();
      let stoppedBy: TurnBudgetStop | undefined;
      const stopForBudget = (stop: TurnBudgetStop): void => {
        if (stoppedBy !== undefined) return;
        stoppedBy = stop;
        budgetAbort.abort(new Error(stop.message));
      };
      const timeLeft = capped
        ? turnBudget.timeLeftMs(ctx.sessionId, limits)
        : undefined;
      const budgetTimer =
        timeLeft === undefined
          ? undefined
          : setTimeout(
              () => {
                const stop = budgetStop();
                if (stop !== undefined) stopForBudget(stop);
              },
              Math.max(0, timeLeft),
            );
      budgetTimer?.unref?.();
      const budgetOptionsFor = (pricing: WorkerPricing | undefined) =>
        capped
          ? {
              shouldStart: (): string | undefined => {
                const stop = stoppedBy ?? budgetStop();
                if (stop === undefined) return undefined;
                stopForBudget(stop);
                return stop.message;
              },
              onWorkerUsage: (
                _taskId: string,
                usage: Parameters<typeof estimateUsageCostUsd>[0],
              ): void => {
                // The service's own bill counts even for an unpriced worker.
                const usd = completionCostUsd(usage, pricing);
                if (usd !== undefined) {
                  turnBudget.addWorkerSpend(ctx.sessionId, usd, deps.requestBudgetAccounting === true);
                }
                const stop = budgetStop();
                if (stop !== undefined) stopForBudget(stop);
              },
            }
          : {};
      // Escalation (ATO-942): only to the configured target, priced with
      // the same resolver as the workers, and counted in the turn's cap.
      // A snapshot-only price estimates its spend but admits nothing.
      const escalationTarget = mode.escalation ?? null;
      const escalationModel = escalationTarget?.model ?? escalationTarget?.providerId;
      const escalationPricing =
        escalationTarget === null || escalationModel === undefined
          ? undefined
          : deps.resolveWorkerPricing?.(escalationTarget.providerId, escalationModel);
      const escalationEstimateOnly =
        escalationPricing !== undefined &&
        escalationTarget !== null &&
        escalationModel !== undefined &&
        deps.resolveWorkerAdmissionPricing !== undefined &&
        deps.resolveWorkerAdmissionPricing(escalationTarget.providerId, escalationModel) === undefined;
      let escalationSpendUsd = 0;
      const escalationOptions =
        escalationTarget === null || deps.escalationComplete === undefined
          ? {}
          : {
              escalation: {
                target: escalationTarget,
                ...(escalationPricing === undefined
                  ? {}
                  : { pricing: escalationPricing }),
                ...(escalationEstimateOnly ? { estimateOnly: true } : {}),
              },
              onEscalationSpend: (_taskId: string, usd: number): void => {
                escalationSpendUsd += usd;
                run?.addSpend(usd);
                turnBudget.addWorkerSpend(ctx.sessionId, usd, deps.requestBudgetAccounting === true);
                const stop = budgetStop();
                if (stop !== undefined) stopForBudget(stop);
              },
            };
      const runSignal = capped
        ? AbortSignal.any([ctx.signal, budgetAbort.signal])
        : ctx.signal;
      // The contract's checks run what the workers wrote: after outside
      // content (`agent.taintReview`) they wait on one more yes, asked
      // once for the call, whichever batch comes first (ATO-618).
      // The folder's egress rule, asked per check before any approval
      // prompt and before the runner, as dispatch does for verify.run.
      const checkEgress: ContractCheckEgressRule | undefined = deps.contractCheckEgress === undefined
        ? undefined
        : (spec) => deps.contractCheckEgress!(spec, ctx);
      const checkHold = createContractCheckHold({
        runner: deps.runChecks,
        approvals: deps.approvals,
        approvalRequired: deps.approvalRequired,
        sessionId: ctx.sessionId,
        // The operator's project, not a candidate copy: rules and the prompt name it.
        workingDir: candidateOriginalDir,
        sourceWorkingDir: ctx.workingDir,
        ...(ctx.incognito || ctx.projectRef === undefined ? {} : {
          uiExceptions: { stateDir: getConfig().paths.stateDir, projectRef: ctx.projectRef },
        }),
        tool: FUSION_DELEGATE_TOOL,
        // Declared checks and provide examples (ATO-1362) are described
        // and held as one batch.
        checks: parsed.contract === undefined ? [] : checksWithExamples(parsed.contract),
        signal: runSignal,
        ...(deps.shellPolicy === undefined ? {} : { shellPolicy: deps.shellPolicy }),
        ...(deps.checkCommandReads === undefined ? {} : { checkCommandReads: deps.checkCommandReads }),
        ...(deps.checkReadTargets === undefined ? {} : { checkReadTargets: deps.checkReadTargets }),
        ...(deps.knownSecrets === undefined ? {} : { knownSecrets: collectKnownSecrets() }),
        ...(ctx.readRoots === undefined ? {} : { readRoots: ctx.readRoots }),
        checkInputs: parsed.contract?.checkInputs ?? [],
        ...(ctx.project?.plan?.status === "approved" ? { turnGrantFolder: candidateOriginalDir } : {}),
      });
      // The run the checks belong to, once its checkpoint exists: a page
      // check's screenshots are kept with it (issue #40). Read per call.
      let checkRun: ContractCheckRun | undefined;
      // How many times the gate ran each check spec in this call (issue #106 review): a reused outcome is said to be reused.
      const gateRunCounts = new Map<string, number>();
      const withCheckDependencies = (runner: ContractCheckRunner | undefined, declarations: readonly Record<string, unknown>[] = parsed.contract?.checks ?? []) =>
        withContractCheckServices(withContractCheckEgress(runner, checkEgress), declarations, checkEgress);
      const heldRunChecks = countGateRuns(withCheckRun(withCheckDependencies(checkHold.runner), () => checkRun), gateRunCounts);
      // Escalation and judge calls name the delegating session, so they
      // count in its spend readout like the workers' own calls (ATO-1388).
      const sideComplete: FusionDelegateDeps["escalationComplete"] =
        deps.escalationComplete === undefined
          ? undefined
          : (call) => deps.escalationComplete!({ ...call, sessionId: ctx.sessionId });
      // Every worker session carries the request unclipped: its brief
      // may quote only the head (a local leg), and the input guard reads
      // the whole request for the files it names (`workerRequestRecord`).
      const executionIdentities = new Map<string, string | undefined>();
      const workerDeps: FusionDelegateDeps = {
        ...deps,
        ...(heldRunChecks === undefined ? {} : { runChecks: heldRunChecks }),
        recordCheckRun,
        ...(deps.knownSecrets === undefined ? {} : { knownSecrets: () => collectKnownSecrets() ?? [] }),
        ...(candidate === undefined ? {} : { ruleWorkdir: candidateOriginalDir }),
        ...(deps.resolveRoutingIdentity === undefined ? {} : { runTurn: (session, message, options) => {
          const taskId = readFusionWorkerMeta(session.metadata)?.taskId;
          const provider = options.providerId;
          if (taskId !== undefined) {
            // A model of the turn's own (a team member's) is not what the
            // entry's identity describes, unless it is the worker leg's.
            const pinnedElsewhere = options.model !== undefined && options.model !== workerModel;
            const identity = provider === taskLegs.get(taskId)?.providerId && provider !== undefined && !pinnedElsewhere
              ? deps.resolveRoutingIdentity?.(provider) : undefined;
            // Once a task's identity changes between turns it stays unattributed.
            if (!executionIdentities.has(taskId)) executionIdentities.set(taskId, identity);
            else if (executionIdentities.get(taskId) !== identity) executionIdentities.set(taskId, undefined);
          }
          return deps.runTurn(session, message, options);
        } }),
        // Named for the folder's provider-policy refusal (issue #33).
        ...(sideComplete === undefined ? {} : {
          escalationComplete: (call) => runWithProviderRole("fusion escalation", () => sideComplete(call)),
        }),
        ...(originalRequest === undefined
          ? {}
          : {
              createEphemeralSession: (meta, workingDir, inheritWorkspace) =>
                deps.createEphemeralSession(
                  { ...meta, operatorRequest: originalRequest },
                  workingDir,
                  inheritWorkspace,
                ),
            }),
      };

      // The judge's acceptance lists (ATO-944), built before any work so
      // every brief carries its own, read-only. Off: no list, no suffix.
      // With a team (issue #38) review is on by `reviewEnabled`: listed
      // reviewers turn it on whatever `fusion.judge` says, `team.review`
      // wins. A task's judge is then the reviewer `pickReviewer` gives for
      // the member that ran it (never weaker, issue #38), on that
      // reviewer's own model; none fits: `judgeProvider` while the judge
      // is on, else no model review. Without a team: `fusion.judge`.
      // (`judgeTarget`, `teamReview` and the plan rows' reviewers are
      // resolved before the fan-out prompt: the plan's yes names them.)
      const judgeTargets = new Map<string, JudgeTarget | null>();
      // Tasks a team reviewer judges: only these get the team's review
      // passes, review clause and review-exhausted hand-off (issue #38).
      // A task judged on `judgeProvider` (no reviewer, or none fits)
      // keeps the legacy judge: one retry, its wording.
      const teamJudged = new Set<string>();
      const judgeTargetFor = (taskId: string): JudgeTarget | null => {
        if (!judgeTargets.has(taskId)) {
          const { member: reviewer, fromPlan } = taskReviewerOf(taskId);
          // The approved row's "no review", or review off: none.
          if (reviewer === null && (fromPlan || teamReview?.on === false)) {
            judgeTargets.set(taskId, null);
            return null;
          }
          if (reviewer !== null && teamReview !== undefined) teamJudged.add(taskId);
          judgeTargets.set(
            taskId,
            reviewer === null
              ? judgeTarget
              : {
                  providerId: reviewer.providerId,
                  model: reviewer.model,
                  ...(team!.pinsModel(reviewer.providerId) ? { pinModel: reviewer.model } : {}),
                },
          );
        }
        return judgeTargets.get(taskId)!;
      };
      const reviewedByTeam = (taskId: string): boolean => {
        judgeTargetFor(taskId);
        return teamJudged.has(taskId);
      };
      // Extra passes a task its review sends back may get: the team's for
      // a task a team reviewer judges, else the judge's one retry.
      const passLimitFor = (taskId: string): number =>
        teamReview !== undefined && reviewedByTeam(taskId) ? teamReview.passes : 1;
      const judging =
        deps.escalationComplete !== undefined &&
        ((teamReview === undefined ? judgeTarget !== null : teamReview.on) ||
          // An approved plan row's reviewer reviews it anyway.
          parsed.tasks.some((t) => taskReviewerOf(t.id).fromPlan && taskReviewerOf(t.id).member !== null));
      const acceptance = new Map(
        judging
          ? parsed.tasks
              .filter((t) => judgeTargetFor(t.id) !== null)
              .map((t) => [
                t.id,
                // Without an approved brief a criterion is still a fact, by id.
                buildAcceptanceChecklist(t, parsed.contract, briefCriteria ?? new Map()),
              ])
          : [],
      );
      const acceptanceSuffix = judging
        ? (taskId: string): string | undefined => {
            const items = acceptance.get(taskId);
            return items === undefined || items.length === 0
              ? undefined
              : renderAcceptanceBlock(items);
          }
        : undefined;
      // The checkpoint (ATO-617): written after every task and wave, so a
      // run cut off by a crash or a quit can be resumed from where it was.
      const runStartedAt = resumedFrom?.startedAt ?? Date.now();
      const run: FusionRunRecorder | undefined = candidate === undefined ? deps.runCheckpoints?.start({
        ...(resume === undefined ? {} : { runId: resume.runId }),
        ...(directorRef === null ? {} : { director: directorRef }),
        sessionId: ctx.sessionId,
        workingDir: ctx.workingDir,
        ...(originalRequest === undefined ? {} : { originalRequest }),
        args: checkpointArgs(delegateArgs),
        tasks: parsed.tasks,
        waveCount: plan.waves.length,
        ...(resumedFrom === null ? {} : { resumedFrom }),
        ...(briefCriteria === undefined ? {} : { criteria: [...briefCriteria.values()] }),
      }) : undefined;
      // The run folder the checks' screenshots and the criteria facts go
      // to (issue #40). Candidate mode keeps no resumable checkpoint, but
      // its evidence still needs a real run (issue #74): a fresh id whose
      // folder holds only shots and facts, so the milestone reads them
      // like any run's.
      const evidenceRun: ContractCheckRun | undefined =
        run !== undefined
          ? { runId: run.runId, sessionId: ctx.sessionId }
          : candidate !== undefined && deps.runCheckpoints !== undefined
            ? { runId: newFusionRunId(), sessionId: ctx.sessionId }
            : undefined;
      if (evidenceRun !== undefined) checkRun = evidenceRun;
      const criterionRunId = evidenceRun?.runId ?? newFusionRunId();
      admitted.runId = criterionRunId;
      admitted.runStartedAt = runStartedAt;
      // Each worker run of a task is an attempt (issue #95): what it wrote
      // and the edits it found already applied stay with that attempt, and
      // the reviewer reads them with the version under review.
      const attemptLedger = new Map<string, AttemptRecord[]>();
      const deliveredPaths = new Set<string>();
      /** A task's declared files, for the hashes its check runs record (issue #104 review). */
      const declaredFilesOf = (taskId: string): readonly string[] => parsed.tasks.find((t) => t.id === taskId)?.files ?? [];
      /**
       * The contract checks that passed on a reviewed version of this
       * call's milestone in its earlier runs (issue #106), newest first,
       * one per check identity, less those this call's contract runs itself.
       */
      const historicalServices = new Map<string, Record<string, unknown>>();
      const priorPassedChecks = (): Record<string, unknown>[] => {
        const runsDir = deps.runCheckpoints?.runsDir;
        const milestoneId = projectVerdict.kind === "admit" ? projectVerdict.milestoneId : null;
        const milestone = milestoneId === null ? undefined : ctx.project?.milestones.find((m) => m.id === milestoneId);
        if (runsDir === undefined || milestone === undefined) return [];
        const own = new Set(checksAsWritten.map((c) => checkSpecKey(c)));
        // A check of this call for the same task naming every criterion an
        // earlier check named supersedes it: the director replaced it (issue #106 review).
        const superseded = (check: Record<string, unknown>): boolean => {
          const criteria = Array.isArray(check.criteria) ? check.criteria.filter((c): c is string => typeof c === "string") : [];
          return criteria.length > 0 && checksAsWritten.some((c) => c.task === check.task && criteria.every((id) => (c.criteria ?? []).includes(id)));
        };
        const seen = new Set<string>();
        const out: Record<string, unknown>[] = [];
        for (const runId of [...milestone.runIds].reverse()) {
          const passed = readRunCriteria(runsDir, runId).passedChecks ?? [];
          for (const check of passed) {
            const key = checkSpecKey(check);
            if (own.has(key) || seen.has(key) || superseded(check)) continue;
            seen.add(key);
            out.push(check);
            if ((check.kind ?? check.type) === "ui" && typeof check.service === "string" && !historicalServices.has(check.service)) {
              const service = passed.find(spec => (spec.kind ?? spec.type) === "service" && spec.id === check.service && spec.task === check.task);
              if (service !== undefined) historicalServices.set(check.service, service);
            }
          }
        }
        return out;
      };
      /**
       * The brief's criteria the runtime knows are uncovered for this
       * call's milestone (issue #106 review): no check of this call names
       * one, and no earlier run of the milestone kept a fact for it. Only
       * in a one-milestone project: the plan does not say which milestone
       * owns a criterion, so in a larger one another milestone may cover it
       * and nothing is called a gap here (a narrower fix-round contract
       * keeps the facts of the runs before it).
       */
      const uncoveredCriteria = (): string[] => {
        if (briefCriteria === undefined || ctx.project === undefined || ctx.project.milestones.length !== 1) return [];
        const milestone = ctx.project.milestones[0]!;
        const named = new Set((parsed.contract?.checks ?? []).flatMap((c) => c.criteria ?? []));
        const runsDir = deps.runCheckpoints?.runsDir;
        if (runsDir !== undefined) {
          for (const runId of milestone.runIds) {
            for (const t of readRunCriteria(runsDir, runId).tasks) t.facts.forEach((f) => named.add(f.id));
          }
        }
        for (const f of milestone.criteriaFacts ?? []) named.add(f.id);
        return [...briefCriteria.values()].filter((c) => !named.has(c.id)).map((c) => c.text);
      };
      /** The newest review an earlier run of the task's milestone recorded for it (issue #104 review). */
      const priorReviewOf = (taskId: string): RunTaskReview | undefined => {
        const runsDir = deps.runCheckpoints?.runsDir;
        const row = ctx.project?.plan?.rows.find((r) => r.taskId === taskId);
        const milestone = row === undefined ? undefined : ctx.project?.milestones.find((m) => m.id === row.milestoneId);
        if (runsDir === undefined || milestone === undefined) return undefined;
        for (const runId of [...milestone.runIds].reverse()) {
          const review = readRunCriteria(runsDir, runId).reviews.find((v) => v.taskId === taskId && (v.verdict === "accept" || v.verdict === "needs-changes"));
          if (review !== undefined) return review;
        }
        return undefined;
      };
      /** A task's declared files hashed now, inside the working dir (issue #104 review). */
      const declaredHashesNow = (taskId: string): Array<{ path: string; sha256?: string }> =>
        declaredFilesOf(taskId).flatMap((path) => {
          const inside = evidencePath([ctx.workingDir], path);
          if (inside === undefined) return [];
          const sha256 = sha256Of(inside.full);
          return [sha256 === undefined ? { path: inside.display } : { path: inside.display, sha256 }];
        });
      const noteAttempt = (result: WorkerTaskResult): void => {
        if (mode.isolation !== "worktree") {
          for (const { path } of result.attempt?.wrote ?? []) deliveredPaths.add(path);
        }
        const list = attemptLedger.get(result.id) ?? [];
        list.push({
          attempt: list.length + 1,
          wrote: result.attempt?.wrote ?? [],
          alreadyApplied: result.attempt?.alreadyApplied ?? [],
          ...(result.attempt?.executed === undefined ? {} : { executed: result.attempt.executed }),
        });
        attemptLedger.set(result.id, list);
      };
      /** The latest attempt marked with what its checks tested; the reviewer's attempts section. */
      const attemptEvidenceFor = (task: DelegateTask, facts: JudgeFacts, workingDir: string, items: readonly AcceptanceItem[] = [], reply?: string): string => {
        const attempts = attemptLedger.get(task.id) ?? [];
        // Only paths inside the working dir or the session's read roots are read and named.
        const roots = [workingDir, ...(ctx.readRoots ?? [])];
        const paths = [...new Set([...(task.files ?? []), ...attempts.flatMap((a) => [...a.wrote.map((w) => w.path), ...a.alreadyApplied])])]
          .flatMap((path) => {
            const inside = evidencePath(roots, path);
            return inside === undefined ? [] : [inside];
          });
        const current = [...new Map(paths.map((p) => [p.display, p])).values()].map(({ display, full }) => {
          const sha256 = sha256Of(full);
          return sha256 === undefined ? { path: display } : { path: display, sha256 };
        });
        const ownChecked = (parsed.contract?.checks ?? []).flatMap((check, index) => {
          const outcome = check.task === task.id ? facts.checkOutcomes[index] : undefined;
          return outcome === undefined ? [] : [{ outcome, runsThisCall: gateRunCounts.get(checkSpecKey(check)) ?? 0 }];
        });
        const own = ownChecked.map((c) => c.outcome);
        const latest = attempts.at(-1);
        if (latest !== undefined && own.length > 0) {
          latest.tested = { passed: own.filter((o) => o.ok).length, total: own.length, versions: current };
        }
        // What the worker's own test runs showed, recorded from the tool results (issue #102).
        // Without the secret metadata the section is left out, never shown unmasked.
        let known: readonly KnownSecret[] | undefined;
        try { known = collectKnownSecrets() ?? []; } catch { known = undefined; }
        const executed = known === undefined ? "" : renderExecutionEvidence(
          attempts.flatMap((a) => (a.executed ?? []).map((run) => ({ ...run, attempt: a.attempt }))),
          current,
          known,
        );
        // The task's own checks as the runtime ran them on these files (issue #104):
        // command, exit, cases, the output and a test-to-criterion mapping.
        const criteriaTexts = [...new Set([
          ...(projectBrief?.successCriteria ?? []),
          ...items.flatMap((item) => (item.kind === "criterion" ? [item.criterion?.text || item.text] : [])),
        ])];
        const gateRuns = ownChecked.flatMap(({ outcome: o, runsThisCall }) => (o.run === undefined ? [] : [{ ok: o.ok, ...o.run, runsThisCall }]));
        // The brief's criteria known to be uncovered (issue #106): apart from name mismatches.
        const uncovered = uncoveredCriteria();
        const checkRuns = known === undefined ? "" : renderCheckRunEvidence(gateRuns, current, criteriaTexts, known, uncovered);
        // No summary from the worker (issue #106): say so, and that the runtime record stands in for it.
        const noSummary = reply !== undefined && isPlaceholderReply(reply)
          ? [
              "## Worker summary",
              // True per case: a worker that ran no check did not end "after its checks" (issue #106 review).
              (attempts.at(-1)?.executed ?? []).length > 0
                ? "The worker gave no summary: it ended after its checks and before replying."
                : "The worker gave no summary, and the runtime recorded no check run of its own.",
              "The runtime record in this prompt is authoritative for what ran and stands in for the summary; do not require a worker summary as evidence.",
            ].join("\n")
          : "";
        return [renderAttemptEvidence(attempts, current, task.files ?? []), checkRuns, executed, noSummary].filter((part) => part.length > 0).join("\n\n");
      };
      // Priced per leg: a role model's task is recorded at its own price.
      const checkpointOptionsFor = (
        pricing: typeof workerPricing,
      ): Pick<
        Parameters<typeof runWorkerTasks>[1],
        "onWorkerTool" | "onTaskFinished"
      > =>
        run === undefined
          ? { onTaskFinished: noteAttempt }
          : {
              onWorkerTool: (taskId: string, tool: string): void =>
                run.noteTool(taskId, tool),
              onTaskFinished: (result: WorkerTaskResult): void => {
                noteAttempt(result);
                // Per call, as the turn budget was charged.
                const costUsd = taskSpendUsd(result, pricing);
                // A proposal is not an answer: its row is written once the
                // split closed (`expandWave`), its spend now. Under isolation
                // nothing has reached the folder yet: `runTasks` writes the
                // row after the merge.
                if (mode.isolation === "worktree" || awaitsExpansion(result)) {
                  run.addSpend(costUsd);
                } else {
                  run.recordTask(result, costUsd);
                }
              },
            };
      // One failure breaker per leg (ATO-1406): a run of identical
      // failures, or one blocker, stops new starts on that leg; workers
      // already running finish. Fed by every finished row, consulted
      // with the turn's caps before each task starts.
      const breakers = new Map<string, FanoutFailureBreaker>();
      const breakerFor = (providerId: string): FanoutFailureBreaker => {
        let breaker = breakers.get(providerId);
        if (breaker === undefined) {
          breaker = new FanoutFailureBreaker(providerId);
          breakers.set(providerId, breaker);
        }
        return breaker;
      };
      const guardOptionsFor = (
        providerId: string,
        pricing: WorkerPricing | undefined,
        model: string,
        tasks: readonly DelegateTask[],
      ): Pick<
        Parameters<typeof runWorkerTasks>[1],
        | "shouldStart"
        | "shouldStartTask"
        | "onWorkerUsage"
        | "onWorkerTool"
        | "onTaskFinished"
      > => {
        const budget: Pick<
          Parameters<typeof runWorkerTasks>[1],
          "shouldStart" | "onWorkerUsage"
        > = budgetOptionsFor(pricing);
        const checkpoint = checkpointOptionsFor(pricing);
        const breaker = breakerFor(providerId);
        // The outcome journal (ATO-949): one row per finished task, counts
        // and labels only. A split's proposal is not an outcome.
        const briefs = new Map(tasks.map((t) => [t.id, t]));
        const leg = deps.workerSupportsSlotAffinity(providerId)
          ? "local"
          : "cloud";
        const logOutcome = (result: WorkerTaskResult): void => {
          if (deps.outcomeJournal === undefined || awaitsExpansion(result)) return;
          deps.outcomeJournal.append(
            outcomeRowFor({
              result,
              task: briefs.get(result.id),
              leg,
              model,
              costUsd:
                pricing !== undefined && result.usage !== undefined
                  ? estimateUsageCostUsd(result.usage, pricing)
                  : null,
              at: Date.now(),
            }),
          );
        };
        return {
          ...budget,
          ...checkpoint,
          // The breaker only gates new tasks; the budget's own check
          // still governs escalations and cuts (ATO-1406).
          shouldStartTask: () => breaker.stopReason(),
          onTaskFinished: (result: WorkerTaskResult): void => {
            if (candidate !== undefined) {
              completedCandidateRows.set(result.id, result);
              if (!(result.error ?? "").startsWith("not started:")) candidateWorkerRuns.set(result.id, Math.min(1_000_000, (candidateWorkerRuns.get(result.id) ?? 0) + 1));
            }
            breaker.observe(result);
            // A finished worker that ran tools answers the format check.
            if (
              (result.status === "ok" || result.status === "no_changes") &&
              result.tools.calls > 0
            ) {
              formatCheck.noteWorkerSucceeded(ctx.sessionId, providerId);
            }
            checkpoint.onTaskFinished?.(result);
            logOutcome(result);
          },
        };
      };
      // The task tree (ATO-940): off unless configured, and then the wave
      // runs and a judge's retry read proposals.
      const tree =
        mode.taskTree === undefined
          ? undefined
          : new TaskTreeState(mode.taskTree, workerModel);
      tree?.addRoots(parsed.tasks, parsed.contract);
      // A split's subtasks count on their root in the checkpoint (ATO-1320).
      if (tree !== undefined) run?.useParents((id) => tree.parentOf(id));
      // One of the orchestrator's own tasks whose worker proposed a split.
      const awaitsExpansion = (row: WorkerTaskResult): boolean =>
        tree !== undefined &&
        tree.depthOf(row.id) === 1 &&
        hasSplitProposal(row.reply);
      const canProposeSplit =
        tree === undefined
          ? undefined
          : (taskId: string): boolean => tree.canSplitAt(tree.depthOf(taskId));
      const waveSuffix =
        tree === undefined
          ? acceptanceSuffix
          : (taskId: string): string | undefined => {
              const parts = [
                acceptanceSuffix?.(taskId),
                canProposeSplit?.(taskId) === true
                  ? renderSplitInstructions(tree.nodesLeft)
                  : undefined,
              ].filter((part): part is string => part !== undefined);
              return parts.length === 0 ? undefined : parts.join("\n\n");
            };
      // The judge's spend counts toward the turn's cap, whether it ruled
      // in a task's workspace before the merge or after the waves.
      let judgeSpendUsd = 0;
      const judgePricingFor = (target: JudgeTarget) =>
        deps.resolveWorkerPricing?.(target.providerId, target.model ?? target.providerId);
      // Every distinct judge that ruled (a team may ask several
      // reviewers), named on the spend line.
      const judgesUsed = new Set<string>();
      // A task that changed nothing (`no_changes`) is judged too (issue #98):
      // its files stand from an earlier attempt, and only the evidence
      // (a check's counts, say) may be new; a re-review of the same files
      // needs no new write.
      const judgeable = (r: WorkerTaskResult): boolean =>
        (acceptance.get(r.id)?.length ?? 0) > 0 &&
        judgeTargetFor(r.id) !== null &&
        // A verify-only regression is the director's to see, not a review pass's to redo (issue #100).
        r.failure !== "regressed-verified" &&
        (r.status === "ok" ||
          r.status === "no_changes" ||
          (r.status === "failed" && (r.error ?? "").startsWith("checks:")));
      // Tasks whose last review was cut short by the budget or a cancel:
      // a stop, never a review that ran out of passes (issue #38).
      const reviewCutShort = new Set<string>();
      // The task's visual checks judged against the criteria they name
      // (issue #40): by the task's judge when it can see, else the next
      // team reviewer that can, else the vision route. Its spend is the
      // judge's; under a $ cap an unpriced judge is not asked, and the
      // criteria stay unverified.
      const addJudgeSpend = (usd: number | null): void => {
        if (usd === null || usd <= 0) return;
        judgeSpendUsd += usd;
        run?.addSpend(usd);
        turnBudget.addWorkerSpend(ctx.sessionId, usd, deps.requestBudgetAccounting === true);
      };
      const visionFor = async (
        input: Parameters<GateJudge>[0],
        target: JudgeTarget,
      ): Promise<{ judgements: VisionJudgements; costUsd: number | null } | undefined> => {
        const criteria = input.items.flatMap((item) => (item.criterion === undefined ? [] : [item.criterion]));
        if (criteria.length === 0) return undefined;
        const vj = deps.visionJudge;
        const asMember = (t: JudgeTarget): TeamMember => {
          const model = t.pinModel ?? t.model ?? t.providerId;
          return { providerId: t.providerId, model, ref: `${t.providerId}:${model}` };
        };
        const judge = vj === undefined
          ? null
          : pickVisionJudge({
              taskReviewer: asMember(target),
              reviewers: team?.reviewers ?? [],
              sees: (m) => currentPolicyAllows(m.providerId) && vj.sees(m),
              route: () => vj.route(),
            });
        const result = await judgeTaskVision({
          taskId: input.task.id,
          criteria,
          contract: input.contract,
          outcomes: input.facts.checkOutcomes,
          workingDir: input.workingDir,
          judge,
          pinsModel: (providerId) => team?.pinsModel(providerId) ?? teamContext?.pinsModel(providerId) ?? true,
          describe: vj === undefined ? undefined : (call) => runWithProviderRole("the fusion vision judge", () => vj.describe(call)),
          admit: (member, worstPromptChars, spentUsd) => {
            const stop = budgetStop();
            if (stop !== undefined) return stop.message;
            if (runSignal.aborted) return "the turn was cancelled";
            if (limits.usd === undefined) return undefined;
            const pricing = deps.resolveWorkerPricing?.(member.providerId, member.model);
            const verified = pricing !== undefined &&
              (deps.resolveWorkerAdmissionPricing === undefined || deps.resolveWorkerAdmissionPricing(member.providerId, member.model) !== undefined);
            if (!verified) return `the turn's $ cap needs a priced judge and ${member.model} has no verified price`;
            const worstUsd = worstCaseCostUsd(worstPromptChars, VISION_MAX_OUTPUT_TOKENS, pricing);
            return turnBudget.check(ctx.sessionId, { usd: limits.usd - worstUsd - spentUsd }, deps.orchestratorTurnSpendUsd?.(ctx.sessionId) ?? 0) === undefined
              ? undefined
              : `the call's worst case (${formatUsd(worstUsd)}) would pass the turn's $ cap with the spend so far`;
          },
          price: (member, usage) => {
            if (usage === undefined) return null;
            return completionCostUsd(usage, deps.resolveWorkerPricing?.(member.providerId, member.model)) ?? null;
          },
          ...(deps.knownSecrets === undefined ? {} : { knownSecrets: collectKnownSecrets() }),
          signal: runSignal,
        });
        if (result.judge !== null) judgesUsed.add(result.judge);
        addJudgeSpend(result.costUsd);
        return { judgements: result.judgements, costUsd: result.costUsd };
      };
      const judgeOne: GateJudge = async (input) => {
        const stop = budgetStop();
        reviewCutShort.delete(input.task.id);
        if (stop !== undefined || runSignal.aborted) {
          reviewCutShort.add(input.task.id);
          // The checks' own criteria facts still stand (issue #40).
          const named = input.items.flatMap((item) => (item.criterion === undefined ? [] : [item.criterion]));
          return {
            ...(named.length === 0 ? {} : { criteria: criteriaFactsFor(named, input.contract, input.facts.checkOutcomes, undefined, criterionRunId) }),
            green: false,
            items: [],
            unverified:
              stop === undefined ? "the turn was cancelled" : `not judged: ${stop.message}`,
            costUsd: null,
            review: { decision: "unverified", issues: [], reviewer: null },
          };
        }
        const target = judgeTargetFor(input.task.id)!;
        judgesUsed.add(target.model ?? target.providerId);
        // A red fact makes the list red whatever vision says: not paid for.
        const red = await hasRedFact(input.items, input.facts, input.workingDir);
        const vision = red ? undefined : await visionFor(input, target);
        const attemptEvidence = attemptEvidenceFor(input.task, input.facts, input.workingDir, input.items, input.reply);
        const lessonSource = ctx.incognito ? undefined : ctx.projectRef;
        const bindingLessons = lessonSource === undefined ? [] : reviewerTaskLessons(
          lessonSource, target.providerId, approvedRows.get(input.task.id)?.lessons ?? [], ctx.project?.lessonDeferred,
        );
        const judged = await judgeTask({
          ...input,
          runId: criterionRunId,
          planReviewerRef: approvedRows.get(input.task.id)?.reviewer ?? null,
          bindingLessons,
          ...(deps.resolveDefaultModel === undefined ? {} : { defaultModelOf: deps.resolveDefaultModel }),
          ...(attemptEvidence.length === 0 ? {} : { attemptEvidence }),
          ...(vision?.judgements === undefined ? {} : { facts: { ...input.facts, vision: vision.judgements } }),
          ...(projectBrief === undefined ? {} : { successCriteria: projectBrief.successCriteria }),
          ...(approvedBrief?.deliverable === undefined ? {} : { deliverable: approvedBrief.deliverable, projectBrief: approvedBrief }),
          ...(projectBrief?.decisions === undefined ? {} : { decisions: projectBrief.decisions }),
          ...(deps.knownSecrets === undefined
            ? {}
            : { knownSecrets: collectKnownSecrets() }),
          target,
          pricing: judgePricingFor(target),
          // Named for the folder's provider-policy refusal (issue #33).
          complete: (call) => {
            if (bindingLessons.length > 0 && lessonSource !== undefined && lessonSourceIsRestricted(lessonSource)) {
              recordRestrictedProjectLessonExposure();
            }
            return runWithProviderRole("the fusion judge", () => sideComplete!(call));
          },
          signal: runSignal,
        });
        if (judged.costUsd !== null && judged.costUsd > 0) {
          judgeSpendUsd += judged.costUsd;
          run?.addSpend(judged.costUsd);
          turnBudget.addWorkerSpend(ctx.sessionId, judged.costUsd, deps.requestBudgetAccounting === true);
        }
        // The vision call's spend (already counted) is the judge's too, on the row.
        const visionUsd = vision?.costUsd ?? null;
        return visionUsd === null ? judged : { ...judged, costUsd: (judged.costUsd ?? 0) + visionUsd };
      };
      // The watch on running workers (issue #43), team runs only: every
      // task's own `watchMinutes`, else `team.watchEveryMinutes`; 0 off.
      // The judge is the task's reviewer (the same pick, policy and model
      // pin as its review; none with `team.review: "off"`), else the
      // director on its own model. Each call
      // checks the turn's budget first and needs a priced judge under a
      // $ cap; its spend counts as the judge's.
      const watchMinutesOf = new Map(parsed.tasks.map((t) => [t.id, t.watchMinutes] as const));
      // Judge calls each task's watch sent, across its runs (the first and
      // every review pass): `team.watchMaxChecks` is the task's, not a run's.
      const watchJudgeCallsUsed = new Map<string, number>();
      // The worst case of every watch judge call in flight, held against
      // the $ cap until its real spend lands: parallel watches cannot
      // together pass a cap each alone would respect.
      let watchReservedUsd = 0;
      const watchFor =
        teamContext === undefined || sideComplete === undefined
          ? undefined
          : (taskId: string): WorkerWatchPlan | undefined => {
              const minutes = watchMinutesOf.get(taskId) ?? watchEveryMinutesOf(teamContext.team);
              if (minutes <= 0) return undefined;
              // The task's reviewer (`taskReviewerOf`: the approved plan
              // row's, else the default; `team.review: "off"` turns
              // the reviewers off for the watch too).
              const reviewer = taskReviewerOf(taskId).member;
              const lead: TeamMember | null =
                reviewer ??
                director ??
                (mode.orchestratorProviderId === null
                  ? null
                  : {
                      providerId: mode.orchestratorProviderId,
                      model: mode.orchestratorModel ?? mode.orchestratorProviderId,
                      ref: `${mode.orchestratorProviderId}:${mode.orchestratorModel ?? mode.orchestratorProviderId}`,
                    });
              if (lead === null) return undefined;
              const target: JudgeTarget = {
                providerId: lead.providerId,
                model: lead.model,
                ...(team?.pinsModel(lead.providerId) === true ? { pinModel: lead.model } : {}),
              };
              const label = target.model ?? target.providerId;
              const cap = watchMaxChecksOf(teamContext.team);
              return {
                intervalMs: minutes * 60_000,
                firstTickJitterMs: watchFirstTickJitterMs(minutes * 60_000, deps.watchRandom),
                maxJudgeCalls: Math.max(0, cap - (watchJudgeCallsUsed.get(taskId) ?? 0)),
                judgeCallCap: cap,
                judgeLabel: label,
                ...(deps.watchClock === undefined ? {} : { clock: deps.watchClock }),
                judge: async ({ prompt, signal }) => {
                  const stop = budgetStop();
                  if (stop !== undefined) return { kind: "skipped", reason: stop.message };
                  if (runSignal.aborted) return { kind: "skipped", reason: "the turn was cancelled" };
                  const pricing = judgePricingFor(target);
                  const verified =
                    pricing !== undefined &&
                    (deps.resolveWorkerAdmissionPricing === undefined ||
                      deps.resolveWorkerAdmissionPricing(target.providerId, label) !== undefined);
                  if (limits.usd !== undefined && !verified) {
                    return { kind: "skipped", reason: `the turn's $ cap needs a priced judge and ${label} has no verified price` };
                  }
                  const worstUsd =
                    limits.usd === undefined || pricing === undefined
                      ? 0
                      : worstCaseCostUsd(prompt.length, WATCH_JUDGE_MAX_OUTPUT_TOKENS, pricing);
                  if (
                    limits.usd !== undefined &&
                    turnBudget.check(
                      ctx.sessionId,
                      { usd: limits.usd - watchReservedUsd - worstUsd },
                      deps.orchestratorTurnSpendUsd?.(ctx.sessionId) ?? 0,
                    ) !== undefined
                  ) {
                    return {
                      kind: "skipped",
                      reason: `the call's worst case (${formatUsd(worstUsd)}) would pass the turn's $ cap with the spend so far`,
                    };
                  }
                  watchReservedUsd += worstUsd;
                  judgesUsed.add(label);
                  watchJudgeCallsUsed.set(taskId, (watchJudgeCallsUsed.get(taskId) ?? 0) + 1);
                  try {
                    const answer = await runWithProviderRole("the fusion watch", () =>
                      sideComplete({
                        providerId: target.providerId,
                        ...(target.pinModel === undefined ? {} : { model: target.pinModel }),
                        prompt,
                        maxOutputTokens: WATCH_JUDGE_MAX_OUTPUT_TOKENS,
                        signal: AbortSignal.any([signal, runSignal]),
                      }),
                    );
                    const costUsd = answer.usage === undefined ? undefined : completionCostUsd(answer.usage, pricing);
                    if (costUsd !== undefined && costUsd > 0) {
                      judgeSpendUsd += costUsd;
                      run?.addSpend(costUsd);
                      turnBudget.addWorkerSpend(ctx.sessionId, costUsd, deps.requestBudgetAccounting === true);
                      const after = budgetStop();
                      if (after !== undefined) stopForBudget(after);
                    }
                    return { kind: "answer", content: answer.content };
                  } catch (err) {
                    return { kind: "failed", reason: err instanceof Error ? err.message : String(err) };
                  } finally {
                    watchReservedUsd -= worstUsd;
                  }
                },
              };
            };
      // Merge only green tasks: under isolation a task's own checks and
      // the judge rule inside its workspace before its merge, and a red
      // one is kept as a patch (`merge-gate.ts`). A judged-red task's
      // workspace is kept for its retry, and removed after the judge.
      const gateState = new MergeGateState();
      // The newest outcome of each contract check, by index, wherever it
      // ran (a gate's workspace or the folder): the outcome row's counts.
      const latestCheckOutcomes = new Map<number, ContractCheckOutcome>();
      // The session's read scope, for the syntax pass (gate and after).
      const syntaxRoots = [
        ctx.workingDir,
        ...(ctx.readRoots ?? []),
        ...writeScope,
      ];
      const keptBranches = new Map<string, KeptBranch>();
      // The review pass running (0: the first run); a gate keeps a red
      // task's workspace while another pass may follow.
      let reviewPass = 0;
      const releaseKept = async (): Promise<void> => {
        const sets = new Set([...keptBranches.values()].map((b) => b.set));
        keptBranches.clear();
        for (const set of sets) await set.cleanup();
      };
      // Branch isolation (ATO-946): with `isolation: "worktree"` each run
      // of tasks (a wave, a judge's retry) gets a workspace per task and
      // is merged back before anything reads the folder. Off: unchanged.
      // Inside a wave the tasks are split across the role legs (ATO-943).
      // A resumed run still owes the merges it was cut off with.
      const merges: MergeTaskSuggestion[] = [...(resumedFrom?.merges ?? [])];
      // Under isolation, what became of each task's workspace, for the
      // outcome log: merged (or conflicted), else held back. A task's
      // last run (a judge's retry) wins.
      const mergeOutcomes = new Map<string, MergeOutcome>();
      const runTasks = async (
        tasks: readonly DelegateTask[],
        contract: DelegateContract | undefined,
        briefSuffix: ((taskId: string) => string | undefined) | undefined,
        allowSplit = false,
      ): Promise<WorkerTaskResult[]> => {
        // Workers are about to run: the milestone's work has started
        // (issue #39), whatever the fan-out's outcome.
        if (tasks.length > 0) admitted.started = true;
        if (mode.isolation !== "worktree") {
          return runAcrossLegs(tasks, contract, briefSuffix, undefined, allowSplit);
        }
        const kept = new Map(
          tasks.flatMap((t) => {
            const branch = keptBranches.get(t.id);
            return branch === undefined ? [] : [[t.id, branch] as const];
          }),
        );
        const wave = await runIsolatedWave({
          realDir: ctx.workingDir,
          tasks,
          writeScope,
          options: { maxCopyBytes: copyLimitBytes, maxGitObjectBytes: gitObjectLimitBytes },
          inputs: contract?.inputs ?? [],
          ...(contract?.provides === undefined ? {} : { provides: contract.provides }),
          run: (rebased, taskWorkspace) =>
            runAcrossLegs(rebased, contract, briefSuffix, taskWorkspace, allowSplit),
          gate: buildMergeGate({
            contract: parsed.contract,
            tasks: parsed.tasks,
            concurrent: tasks.map((t) => t.id),
            runChecks: heldRunChecks,
            recordCheckRun,
            ...(deps.knownSecrets === undefined
              ? {}
              : { knownSecrets: collectKnownSecrets() }),
            signal: runSignal,
            state: gateState,
            syntax: { runner: deps.syntaxCheck, roots: syntaxRoots },
            ...(judging
              ? {
                  judge: {
                    items: (id: string) => acceptance.get(id),
                    judgeable,
                    run: judgeOne,
                    keepForRetry: tasks.some((t) => reviewPass < passLimitFor(t.id)),
                  },
                }
              : {}),
          }),
          ...(kept.size === 0 ? {} : { kept }),
        });
        for (const [id, branch] of wave.kept ?? []) keptBranches.set(id, branch);
        // What reached the folder after a gate ruled: a later merge into a
        // gated task's files makes its verdict stale (re-run after the waves).
        for (const outcome of wave.outcomes) {
          for (const path of outcome.applied) deliveredPaths.add(path);
          const task = tasks.find((t) => t.id === outcome.taskId);
          gateState.noteMerge(
            outcome,
            (task?.files ?? []).flatMap((f) => {
              const rel = relative(ctx.workingDir, resolvePath(ctx.workingDir, f));
              return rel.length === 0 || rel.startsWith("..") || isAbsolute(rel) ? [] : [rel];
            }),
          );
        }
        if (wave.inPlace !== undefined) gateState.noteInPlace();
        else {
          const conflicted = new Map(
            wave.outcomes.map((o) => [o.taskId, o.conflicts.length > 0] as const),
          );
          for (const t of tasks) {
            const c = conflicted.get(t.id);
            mergeOutcomes.set(t.id, c === undefined ? "held" : c ? "conflict" : "merged");
          }
        }
        merges.push(...wave.merges);
        run?.recordMerges(wave.merges);
        for (const row of wave.results) {
          if (!awaitsExpansion(row)) run?.recordTask(row);
        }
        return wave.results;
      };
      const runOnLeg = (
        tasks: readonly DelegateTask[],
        contract: DelegateContract | undefined,
        briefSuffix: ((taskId: string) => string | undefined) | undefined,
        taskWorkspace:
          | ((
              taskId: string,
            ) => { workingDir: string; writeScope: readonly string[] } | undefined)
          | undefined,
        allowSplit: boolean,
        concurrentTaskIds: readonly string[],
      ): Promise<WorkerTaskResult[]> =>
        runWorkerTasks(
          // Workers run in the parent's folder in every model mode, so a
          // live folder switch reaches them too (#1121). Only cloud
          // workers inherit the parent's workspace.
          { ...workerDeps, workingDir: ctx.workingDir, ...(ctx.modelMode === "cloud" ? { inheritWorkspace: true } : {}) },
          {
            ...(originalRequest === undefined ? {} : { originalRequest }),
            ...(contract === undefined ? {} : { contract }),
            ...(projectBrief === undefined ? {} : { project: projectBrief }),
            ...(ctx.incognito || ctx.projectRef === undefined ? {} : {
              projectLessonSource: ctx.projectRef,
              projectLessonIds: (taskId: string) => approvedRows.get(taskId)?.lessons,
              ...(ctx.project?.lessonDeferred === undefined ? {} : { deferredProjectLessons: ctx.project.lessonDeferred }),
            }),
            parentSessionId: ctx.sessionId,
            tasks,
            concurrentTaskIds,
            maxWorkers: workerLegMaxWorkers,
            acquireTaskPermit: acquirePermitFor(slotAffine),
            providerId: workerProviderId,
            ...(workerLegPin === undefined ? {} : { model: workerLegPin }),
            workerModel,
            workerMaxSteps: mode.workerMaxSteps,
            workerTimeoutMs: mode.workerTimeoutMs,
            localTokensPerSecond,
            localLeg: Number.isFinite(poolSize),
            ...(mode.workerReasoning === undefined
              ? {}
              : { workerReasoning: mode.workerReasoning }),
            ...(workerMaxOutputTokens === undefined
              ? {}
              : { workerMaxOutputTokens }),
            writeScope,
            signal: runSignal,
            ...guardOptionsFor(workerProviderId, workerPricing, workerModel, tasks),
            ...escalationOptions,
            ...(watchFor === undefined ? {} : { watch: watchFor }),
            ...(briefSuffix === undefined ? {} : { briefSuffix }),
            ...(workerPricing === undefined ? {} : { workerPricing }),
            ...(taskWorkspace === undefined ? {} : { taskWorkspace }),
            ...(allowSplit && canProposeSplit !== undefined
              ? { canProposeSplit }
              : {}),
          },
        );
      // A role model's leg (ATO-943): its own provider, label, price and
      // width. A cloud leg takes the cloud cap; a second local server is
      // one at a time, since its slots are nobody's measurement. The
      // escalation target is dropped where it is this very provider.
      const rolePricing = new Map(
        [...roleLegs.values()].map((leg) => [
          legKey(leg),
          deps.resolveWorkerPricing?.(leg.providerId, leg.model),
        ]),
      );
      const runOnRoleLeg = (
        leg: TaskLeg,
        tasks: readonly DelegateTask[],
        contract: DelegateContract | undefined,
        briefSuffix: ((taskId: string) => string | undefined) | undefined,
        taskWorkspace:
          | ((
              taskId: string,
            ) => { workingDir: string; writeScope: readonly string[] } | undefined)
          | undefined,
        allowSplit: boolean,
        concurrentTaskIds: readonly string[],
      ): Promise<WorkerTaskResult[]> => {
        const local = deps.workerSupportsSlotAffinity(leg.providerId);
        const pricing = rolePricing.get(legKey(leg));
        const roles = new Set(
          tasks.map((t) => taskLegs.get(t.id)?.role ?? "-"),
        );
        const onlyRole = roles.size === 1 ? [...roles][0] : "-";
        return runWorkerTasks(
          { ...workerDeps, workingDir: ctx.workingDir, ...(ctx.modelMode === "cloud" ? { inheritWorkspace: true } : {}) },
          {
            ...(originalRequest === undefined ? {} : { originalRequest }),
            ...(contract === undefined ? {} : { contract }),
            ...(projectBrief === undefined ? {} : { project: projectBrief }),
            ...(ctx.incognito || ctx.projectRef === undefined ? {} : {
              projectLessonSource: ctx.projectRef,
              projectLessonIds: (taskId: string) => approvedRows.get(taskId)?.lessons,
              ...(ctx.project?.lessonDeferred === undefined ? {} : { deferredProjectLessons: ctx.project.lessonDeferred }),
            }),
            parentSessionId: ctx.sessionId,
            tasks,
            concurrentTaskIds,
            maxWorkers: Math.min(maxWorkers, roleLegWidth(leg, tasks.length)),
            acquireTaskPermit: acquirePermitFor(local),
            providerId: leg.providerId,
            ...(leg.pinModel === undefined ? {} : { model: leg.pinModel }),
            workerModel:
              onlyRole === "-" ? leg.model : `${leg.model} (${onlyRole})`,
            workerMaxSteps: mode.workerMaxSteps,
            workerTimeoutMs: mode.workerTimeoutMs,
            localTokensPerSecond: null,
            localLeg: local,
            ...(mode.workerReasoning === undefined
              ? {}
              : { workerReasoning: mode.workerReasoning }),
            ...(mode.workerMaxOutputTokens === undefined
              ? {}
              : { workerMaxOutputTokens: mode.workerMaxOutputTokens }),
            writeScope,
            signal: runSignal,
            ...guardOptionsFor(leg.providerId, pricing, leg.model, tasks),
            ...(watchFor === undefined ? {} : { watch: watchFor }),
            // An orchestrator task already runs on the strongest model
            // the session holds: whichever escalation provider is
            // configured, it can only be the same or a weaker one.
            ...(escalationTarget?.providerId === leg.providerId ||
            leg.orchestrator === true
              ? {}
              : escalationOptions),
            ...(briefSuffix === undefined ? {} : { briefSuffix }),
            ...(pricing === undefined ? {} : { workerPricing: pricing }),
            ...(taskWorkspace === undefined ? {} : { taskWorkspace }),
            ...(allowSplit && canProposeSplit !== undefined
              ? { canProposeSplit }
              : {}),
          },
        );
      };
      // Every leg's share of a wave runs at once; rows come back in the
      // caller's task order. No role legs: exactly the old single call.
      const runAcrossLegs = async (
        tasks: readonly DelegateTask[],
        contract: DelegateContract | undefined,
        briefSuffix: ((taskId: string) => string | undefined) | undefined,
        taskWorkspace:
          | ((
              taskId: string,
            ) => { workingDir: string; writeScope: readonly string[] } | undefined)
          | undefined,
        allowSplit: boolean,
      ): Promise<WorkerTaskResult[]> => {
        // The whole run of tasks, whichever leg each lands on: what a
        // worker's self-check must not ask of it (`concurrentPaths`).
        const concurrent = tasks.map((t) => t.id);
        if (roleLegs.size === 0) {
          return runOnLeg(tasks, contract, briefSuffix, taskWorkspace, allowSplit, concurrent);
        }
        const onWorkerLeg = tasks.filter(
          (t) => taskLegs.get(t.id)?.isWorkerLeg !== false,
        );
        const groups = await Promise.all([
          onWorkerLeg.length === 0
            ? Promise.resolve<WorkerTaskResult[]>([])
            : runOnLeg(onWorkerLeg, contract, briefSuffix, taskWorkspace, allowSplit, concurrent),
          ...[...roleLegs.values()].map((leg) => {
            const mine = tasks.filter((t) => onLeg(t, leg));
            return mine.length === 0
              ? Promise.resolve<WorkerTaskResult[]>([])
              : runOnRoleLeg(leg, mine, contract, briefSuffix, taskWorkspace, allowSplit, concurrent);
          }),
        ]);
        const byId = new Map(groups.flat().map((r) => [r.id, r]));
        return tasks.flatMap((t) => {
          const row = byId.get(t.id);
          return row === undefined ? [] : [row];
        });
      };
      // A proposal's children: run through the same runner (width, caps,
      // approval scope), then their own contract is checked before their
      // parent closes on them.
      const expandWave = async (
        tasks: readonly DelegateTask[],
        rows: WorkerTaskResult[],
      ): Promise<WorkerTaskResult[]> => {
        if (tree === undefined) return rows;
        const proposed = new Set(rows.filter(awaitsExpansion).map((r) => r.id));
        const expanded = await expandSplits(tasks, rows, {
              tree,
              workingDir: ctx.workingDir,
              ...(parsed.contract === undefined
                ? {}
                : { parentContract: parsed.contract }),
              workerMaxSteps: mode.workerMaxSteps,
              workerTimeoutMs: mode.workerTimeoutMs,
              runChildren: async (children, childContract, suffix) => {
                // The proposal's complete check contract must be described and
                // approved before a child can execute even an own self-check.
                const held = await checkHold.decide(runSignal, childContract === undefined ? [] : checksWithExamples(childContract));
                if (held !== undefined) return children.map(child => ({ ...notStartedResult(child, held), status: "needs_orchestrator" as const }));
                // A split stays on the leg its parent ran on and is billed at.
                for (const child of children) {
                  const parentId = tree.parentOf(child.id);
                  const leg =
                    parentId === undefined ? undefined : taskLegs.get(parentId);
                  if (leg !== undefined) taskLegs.set(child.id, leg);
                }
                return runTasks(children, childContract, suffix, true);
              },
              evaluateChildren: async (rows, children, childContract) => {
                const provides = await inspectContractProvides(
                  childContract,
                  children,
                  ctx.workingDir,
                  { results: rows, signal: runSignal },
                );
                const checks = await runContractChecks(
                  checksWithExamples(childContract),
                  heldRunChecks,
                  {
                    workingDir: ctx.workingDir,
                    signal: runSignal, filesOf: declaredFilesOf, recordCheckRun,
                    ...(deps.knownSecrets === undefined
                      ? {}
                      : { knownSecrets: collectKnownSecrets() }),
                  },
                );
                const failedChecks = [
                  ...checks.outcomes.filter((o) => o.task === undefined && !o.ok).map((o) => o.detail),
                  ...(checks.checksSkipped === undefined ? [] : [checks.checksSkipped]),
                ];
                return {
                  rows: applyCheckOutcomes(
                    applyContractFindings(rows, provides.findings),
                    checks.outcomes,
                  ),
                  ...(failedChecks.length === 0 ? {} : { failedChecks }),
                };
              },
              mayStart: () =>
                !ctx.signal.aborted &&
                stoppedBy === undefined &&
                budgetStop() === undefined,
            });
        // The closed parents. One a stop cut short stays unsettled, so a
        // resume runs it again instead of reporting half a split.
        for (const row of expanded) {
          if (proposed.has(row.id) && (row.status === "ok" || !ctx.signal.aborted)) {
            run?.recordTask(row);
          }
        }
        return expanded;
      };

      // Issue #40 counts on the task's outcome row: its criteria facts by
      // state, its game checks summed, its screenshots.
      const qualityOutcomeOf = (r: WorkerTaskResult): Pick<TaskOutcomeContext, "criteria" | "games" | "shots"> => {
        const outcomes = (parsed.contract?.checks ?? []).flatMap((check, index) => {
          const outcome = check.task === r.id ? (latestCheckOutcomes.get(index) ?? gateState.checkOutcomes.get(index)) : undefined;
          return outcome === undefined ? [] : [outcome];
        });
        const games = gamesOutcome(outcomes.flatMap((o) =>
          o.games === undefined ? [] : [{ n: o.games.played, errors: o.games.errors, medianMs: o.games.medianMs ?? 0 }]));
        const shots = shotsOutcome(outcomes.map((o) => o.screenshots));
        return {
          ...(r.criteria === undefined ? {} : { criteria: criteriaOutcome(r.criteria) }),
          ...(games === undefined ? {} : { games }),
          ...(shots === 0 ? {} : { shots }),
        };
      };
      const outcomeRowsFor = (ran: readonly WorkerTaskResult[], now: Date) => ran.map((r) => {
            const leg = taskLegs.get(r.id);
            const providerId = leg?.providerId ?? workerProviderId;
            const legKind: OutcomeLeg =
              leg?.orchestrator === true
                ? "orchestrator"
                : deps.workerSupportsSlotAffinity(providerId)
                  ? "local"
                  : "cloud";
            const pricing =
              leg === undefined || leg.isWorkerLeg
                ? workerPricing
                : rolePricing.get(legKey(leg));
            return {
              row: r,
              record: taskOutcomeRecord(
                r,
                {
                  provider: providerId,
                  model: leg?.model ?? workerModel,
                  leg: legKind,
                  role: leg?.orchestrator === true ? "orchestrator" : (leg?.role ?? null),
                  taskRole: parsed.tasks.find((task) => task.id === r.id)?.role ?? null,
                  ...(() => {
                    const milestoneId = ctx.project?.plan?.rows.find((planRow) => planRow.taskId === r.id)?.milestoneId;
                    return milestoneId === undefined ? {} : { milestoneId };
                  })(),
                  ...(executionIdentities.get(r.id) !== undefined && executionIdentities.get(r.id) === deps.resolveRoutingIdentity?.(providerId)
                    ? { routingIdentity: executionIdentities.get(r.id) } : {}),
                  attempt: turnBudget.attempts(ctx.sessionId, r.id),
                  // Issue #30: 0 is the report's "no-checks", apart from
                  // a declared check whose evidence is missing.
                  taskChecks: (parsed.contract?.checks ?? []).filter((check) => check.task === r.id).length,
                  pricing,
                  merge:
                    mode.isolation === "worktree" ? (mergeOutcomes.get(r.id) ?? null) : null,
                  // Only a task a review ran on (issue #38): the team's
                  // passes, or the judge's one retry without a team.
                  ...(r.review !== undefined
                    ? { review: reviewOutcome(r.review, r.review.passes) }
                    : r.judge?.review !== undefined
                      ? { review: reviewOutcome(r.judge.review, r.judge.passes ?? (r.judge.retried ? 1 : 0)) }
                      : {}),
                  ...qualityOutcomeOf(r),
                },
                ctx.sessionId,
                now,
              ),
              pricing,
            };
          });
      recordCandidateInterruption = (report) => {
        if (candidateOutcomesRecorded) return;
        candidateOutcomesRecorded = true;
        const ran = [...completedCandidateRows.values()].filter(row => !(row.error ?? "").startsWith("not started:"));
        deps.outcomeLog?.append(outcomeRowsFor(ran, new Date()).map(({ record, row }) =>
          withCandidateOutcome(record, report.acceptanceReceipt!, report.contract?.checks ?? [], row.id, candidateWorkerRuns.get(row.id))));
      };
      const fanoutStartedAt = Date.now();
      const endLiveFanout = formatCheck.beginFanout(checkedServers);
      try {
        let results: WorkerTaskResult[];
        try {
          // A resume starts with what finished before the restart, and with
          // the tasks that wait for the person's yes; neither runs here.
          const finished = new Map<string, WorkerTaskResult>(
            resume === undefined
              ? []
              : [...resume.carried, ...resume.needsConfirmation].map((r) => [
                  r.id,
                  r,
                ]),
          );
          // Workers are about to start: this round counts toward the
          // turn's caps (ATO-1406), with only the tasks it will run — a
          // resume's finished ones are not counted twice.
          if (tracksTurn) {
            turnBudget.noteRound(ctx.sessionId, actionableTaskCount, actionableOrchestratorTaskIds.length);
          }
          // Worker completion alone does not establish that a required
          // artifact is usable. Verify providers before releasing consumers,
          // including rows carried from a checkpoint. Retry policy is separate.
          const verifiedProviders = new Set<string>();
          // A `no_changes` provider whose required artifacts already exist
          // and pass the same verification as an `ok` one releases its
          // dependents; its own row stays `no_changes`.
          const releasedNoChanges = new Set<string>();
          const previouslyReleased = new Set<string>();
          const verifyProvider = async (id: string): Promise<void> => {
            if (verifiedProviders.has(id)) return;
            verifiedProviders.add(id);
            verifiedNoChangesProviders.delete(id);
            const rechecking = previouslyReleased.has(id);
            previouslyReleased.add(id);
            const original = finished.get(id);
            const noChanges = original?.status === "no_changes";
            if (original === undefined || (original.status !== "ok" && !noChanges)) return;
            // A candidate promotes only all-ok rows, so a released consumer's
            // work could never be delivered: hold it instead.
            if (noChanges && candidate !== undefined) return;
            let row: WorkerTaskResult | undefined = noChanges ? { ...original, status: "ok" } : original;
            let ranEvidence = false;
            const names = new Set((parsed.contract?.requires ?? []).map((r) => r.name));
            const required = (parsed.contract?.provides ?? []).filter(
              (p) => p.task === id && names.has(p.name),
            );
            if (required.length === 0) return;
            const task = parsed.tasks.find((t) => t.id === id)!;
            // F44 permits pathless `other` completion tokens as advisory
            // ordering. They are never evidence that an artifact exists.
            const verifiable = required.filter((p) => p.kind !== "other" ||
              provideSearchPaths(p, parsed.contract!, task).length > 0);
            // Advisory tokens are no evidence for a worker that wrote nothing.
            if (noChanges && verifiable.length < required.length) return;
            const report = await inspectContractProvides(
              { ...parsed.contract, provides: verifiable }, [task], ctx.workingDir,
              { results: [row], signal: runSignal },
            );
            row = applyContractFindings([row], report.findings)[0]!;
            if (report.findings.length !== verifiable.length || report.findings.some((f) => !f.present)) {
              row = { ...row, status: "failed", error: "dependency: required provides are missing or cannot be verified" };
            }
            if (row.status === "ok") {
              const stale = gateState.staleCheckIndices();
              const own = (parsed.contract?.checks ?? []).flatMap((check, index) =>
                check.task === id && (rechecking || !gateState.checkOutcomes.has(index) || stale.has(index))
                  ? [{ check, index }] : [],
              );
              const checks = await runContractChecks(own.map((c) => c.check), heldRunChecks, {
                workingDir: ctx.workingDir, signal: runSignal, filesOf: declaredFilesOf, recordCheckRun,
                ...(deps.knownSecrets === undefined ? {} : { knownSecrets: collectKnownSecrets() }),
              });
              const previous = own.flatMap((c) => {
                const outcome = dependencyCheckOutcomes.get(c.index) ?? gateState.checkOutcomes.get(c.index);
                return outcome === undefined ? [] : [outcome];
              });
              own.forEach((c, i) => {
                const outcome = checks.outcomes[i];
                if (outcome !== undefined) dependencyCheckOutcomes.set(c.index, outcome);
              });
              row = applyPostMergeChecks([row], checks.outcomes, previous)[0]!;
              ranEvidence ||= checks.checksSkipped === undefined && checks.outcomes.length > 0 && checks.outcomes.length === own.length && checks.outcomes.every((o) => o.ok);
              if (checks.checksSkipped !== undefined) {
                row = { ...row, status: "needs_orchestrator", error: `dependency: ${checks.checksSkipped}` };
              }
            }
            // A fresh task-level gate covers its changed/declared paths,
            // not an unchanged required artifact inferred from its contract.
            const files = [...new Set([...(task.files ?? []), ...report.findings.flatMap((f) => f.where)])];
            const gatedPaths = new Set(syntaxPassFiles(row, task).map((file) => resolvePath(ctx.workingDir, file)));
            const uncovered = files.some((file) => !gatedPaths.has(resolvePath(ctx.workingDir, file)));
            if (row.status === "ok" && (rechecking || !gateState.syntaxGated.has(id) || gateState.isStale(id) || uncovered)) {
              [row] = await runSyntaxPass([row], [{ ...task, files }], {
                runner: deps.syntaxCheck, workingDir: ctx.workingDir, roots: syntaxRoots, signal: runSignal,
                ...(deps.knownSecrets === undefined ? {} : { knownSecrets: collectKnownSecrets() }),
              });
              const syntax = row!.syntax;
              ranEvidence ||= syntax !== undefined && syntax.error === undefined && syntax.checked > 0 && syntax.failedFiles.length === 0;
            }
            if (noChanges) {
              // Artifact presence alone is no evidence: at least one own check
              // or syntax check must actually have run here and passed.
              if (row!.status === "ok" && ranEvidence) { releasedNoChanges.add(id); verifiedNoChangesProviders.add(id); }
              return;
            }
            if (row!.status !== "ok") gateState.verdicts.delete(id);
            finished.set(id, row!);
            run?.recordTask(row!);
          };
          for (const [waveIndex, wave] of plan.waves.entries()) {
            // An intervening worker can change check inputs through a shell,
            // even with no file-tool telemetry. Deduplicate only this release.
            verifiedProviders.clear();
            releasedNoChanges.clear();
            for (const id of wave) {
              for (const provider of plan.dependencies.get(id) ?? []) await verifyProvider(provider);
            }
            waveWarnings.push(
              ...dependencyWarnings(wave, plan.dependencies, finished),
            );
            // Fresh each wave, not accumulated: the notes are recomputed
            // from everything finished so far, so appending them to the
            // running warning list would repeat every earlier wave.
            const contract = contractForWave(parsed.contract, [
              ...waveWarnings,
              ...completedWaveNotes(finished),
            ]);
            // Dependency readiness is mandatory; autoReplan only decides
            // whether the planner is asked to retry the held work.
            const held = wave.filter((id) =>
                    !finished.has(id) &&
                    (plan.dependencies.get(id) ?? []).some((provider) => {
                      const done = finished.get(provider);
                      return done?.status !== "ok" && !releasedNoChanges.has(provider);
                    }),
                  );
            for (const id of held) {
              const task = parsed.tasks.find((t) => t.id === id)!;
              const waitingOn = (plan.dependencies.get(id) ?? []).filter(
                (provider) => {
                  const done = finished.get(provider);
                  return done?.status !== "ok" && !releasedNoChanges.has(provider);
                },
              );
              finished.set(id, {
                ...notStartedResult(
                  task,
                  `${autoReplan > 0 ? "held for the replan" : "dependency blocked"}: it depends on ${waitingOn.join(", ")}, which did not close${plan.cycle === undefined ? "" : `; ${plan.cycle}`}`,
                ),
                heldOn: waitingOn,
              });
            }
            const waveTasks = parsed.tasks.filter(
              (t) =>
                wave.includes(t.id) &&
                !held.includes(t.id) &&
                !finished.has(t.id),
            );
            const waveResults = await expandWave(
              waveTasks,
              await runTasks(waveTasks, contract, waveSuffix, true),
            );
            for (const result of waveResults) finished.set(result.id, result);
            run?.recordWave(waveIndex + 1);
          }
          // In the caller's task order, whatever wave each ran in.
          results = parsed.tasks.flatMap((t) => {
            const result = finished.get(t.id);
            return result === undefined ? [] : [result];
          });
        } catch (err) {
          // `runWorkerTasks` is written not to throw; if it ever does, the
          // orchestrator still gets a readable result rather than a dead turn.
          // The checkpoint stays: what finished can still be resumed.
          run?.finish("interrupted");
          if (run !== undefined) runAccounting.close(run.runId);
          await releaseKept();
          if (candidate !== undefined) throw err;
          return error(
            `the fan-out failed: ${err instanceof Error ? err.message : String(err)}`,
            { reason: "fan-out-failed" },
          );
        }
        // Each task this call actually started is one attempt at it this
        // turn; the replan bound (ATO-941) is counted against these. A task
        // held or kept from starting has not been tried. Counted with
        // autoReplan off too: the outcome log's `attempt` must see the
        // orchestrator's own re-delegation of a failed task.
        const ranNow = new Set<string>();
        // Rows carried from before a restart (ATO-617) were not run now.
        const carried = new Set(resume?.carried.map((r) => r.id) ?? []);
        for (const r of results) {
          if (!(r.error ?? "").startsWith("not started:") && !carried.has(r.id)) {
            ranNow.add(r.id);
          }
        }
        // One round per family: a split's continuations (`t3.a`, `t3.b`)
        // count once, on the task they continue.
        turnBudget.noteRoundAttempts(ctx.sessionId, [...ranNow]);
        if (autoReplan > 0) {
          // Across rounds: a task that ran there once is not steered back.
          turnBudget.noteOrchestratorRuns(
            ctx.sessionId,
            [...ranNow].filter((id) => taskLegs.get(id)?.orchestrator === true),
          );
        }
        // What the failure breakers saw (ATO-1406): remembered for the
        // rest of the turn, so the next round on a broken leg is refused.
        const trips: BreakerTrip[] = [...breakers.values()]
          .map((b) => b.tripped())
          .filter((t): t is BreakerTrip => t !== undefined);
        // One trip per error per round: two legs stopping on the same
        // repeat are one round's evidence, not two.
        const seen = new Set<string>();
        for (const trip of trips) {
          if (seen.has(trip.signature)) continue;
          seen.add(trip.signature);
          turnBudget.noteTrip(ctx.sessionId, trip);
        }
        // Rows a cap cut short say so, so a cancelled worker is not read
        // as the operator's doing.
        let budgetStopped = stoppedBy as TurnBudgetStop | undefined;
        if (budgetStopped !== undefined && !ctx.signal.aborted) {
          const stopMessage = budgetStopped.message;
          results = results.map((r) =>
            r.status === "cancelled" && !r.error?.startsWith("not started:")
              ? {
                  ...r,
                  notes: [
                    ...(r.notes ?? []),
                    `stopped by the turn's cap: ${stopMessage}`,
                  ],
                }
              : r,
          );
        }

        // The contract's verdict, from the disk and the check runner, folded
        // into the rows BEFORE the head line counts them: a task whose
        // declared check failed is `failed` in the table the orchestrator
        // reads, not `ok` with a footnote.
        let contract: ContractReport | undefined;
        // Check outcomes in `contract.checks` order, for the judge.
        let checkOutcomes: readonly (ContractCheckOutcome | undefined)[] = [];
        // Folds the disk and the check runner into `rows`. Run once after
        // the waves and, for the tasks a judge sent back, once after their
        // retry — on the retried rows only, so nothing is applied twice.
        const evaluateContract = async (
          rows: WorkerTaskResult[],
          allRows: WorkerTaskResult[],
        ): Promise<WorkerTaskResult[]> => {
          if (parsed.contract === undefined) return rows;
          // `allRows` goes in so a task that never ran is not accused of
          // failing to provide: a cancelled fan-out leaves the disk empty
          // for reasons that are not the worker's.
          const provides = await inspectContractProvides(
            parsed.contract,
            parsed.tasks,
            ctx.workingDir,
            { results: allRows, signal: runSignal },
          );
          let out = applyContractFindings(rows, provides.findings);
          // A check a gate already ran in its task's workspace (isolation)
          // is not run again unless what reached the folder since differs
          // (`MergeGateState`: a three-way merge, a later merge into the
          // task's files, a wave in place); the rest run here, on the
          // merged folder.
          // The declared checks, then one call per provide `example`
          // (ATO-1362). Examples come last, so declared indices (the gate
          // state's, the judge's) are unchanged; no gate ran an example,
          // so each one runs here on the merged folder.
          const allChecks = checksWithExamples(parsed.contract);
          const declaredChecks = (parsed.contract.checks ?? []).length;
          const stale = gateState.staleCheckIndices();
          const pending = allChecks.flatMap((check, index) =>
            gateState.checkOutcomes.has(index) && !stale.has(index) ? [] : [{ check, index }],
          );
          const checks = await runContractChecks(
            pending.map((p) => p.check),
            heldRunChecks,
            {
              workingDir: ctx.workingDir,
              signal: runSignal, filesOf: declaredFilesOf, recordCheckRun,
              ...(deps.knownSecrets === undefined
                ? {}
                : { knownSecrets: collectKnownSecrets() }),
            },
          );
          const ran = checks.outcomes.length === pending.length;
          out = applyPostMergeChecks(
            out,
            checks.outcomes,
            ran
              ? pending.flatMap((p) => {
                  const previous = dependencyCheckOutcomes.get(p.index) ??
                    (stale.has(p.index) ? gateState.checkOutcomes.get(p.index) : undefined);
                  return previous === undefined ? [] : [previous];
                })
              : [],
          );
          // Held after outside content: each row whose own checks were
          // among them says so, its status kept but its acceptance unverified.
          if (checks.checksSkipped?.includes(CONTRACT_CHECKS_HELD) === true) {
            const heldTasks = new Set(pending.flatMap((p) => (typeof p.check.task === "string" ? [p.check.task] : [])));
            const note = `${CONTRACT_CHECKS_HELD} (acceptance unverified)`;
            out = out.map((r) =>
              heldTasks.has(r.id) && !(r.notes ?? []).includes(note)
                ? { ...r, notes: [...(r.notes ?? []), note] }
                : r,
            );
          }
          const byIndex = new Map(gateState.checkOutcomes);
          if (ran) {
            pending.forEach((p, i) => {
              const outcome = checks.outcomes[i]!;
              byIndex.set(p.index, outcome);
              if (!stale.has(p.index)) return;
              gateState.checkOutcomes.set(p.index, outcome);
              // Its gate verdict was green on files the folder no longer has.
              if (!outcome.ok && outcome.task !== undefined) {
                gateState.verdicts.delete(outcome.task);
              }
            });
          } else {
            // A stale verdict is no verdict.
            for (const index of stale) byIndex.delete(index);
          }
          const allOutcomes = allChecks.flatMap((_, i) => {
            const outcome = byIndex.get(i);
            return outcome === undefined ? [] : [outcome];
          });
          for (const [index, outcome] of byIndex) latestCheckOutcomes.set(index, outcome);
          checkOutcomes =
            allOutcomes.length === allChecks.length ? allOutcomes.slice(0, declaredChecks) : [];
          // What the call was run with despite the contract — a require
          // nobody provides, a provide nothing can check, a cycle in the
          // requires, a provider that had not delivered when its dependent
          // ran. The workers read it in their block; the orchestrator
          // reads it here, on the line and in the details.
          const warnings = [...(parsed.contract.warnings ?? []), ...waveWarnings];
          contract = {
            findings: provides.findings,
            ...(provides.providesSkipped === undefined
              ? {}
              : { providesSkipped: provides.providesSkipped }),
            checks: allOutcomes,
            ...(checks.checksSkipped === undefined
              ? {}
              : { checksSkipped: checks.checksSkipped }),
            ...(warnings.length === 0 ? {} : { warnings }),
          };
          return out;
        };
        // The delegate's own syntax pass (`syntax-pass.ts`): the green
        // rows' changed files through `verify.syntax`'s checker, inside the
        // session's read scope, before the judge and the head line see
        // them. A failure demotes the row as a failed check does.
        // Under isolation the gate already ran it in each merged task's
        // workspace (`merge-gate.ts`); here it covers the rest (a wave
        // that ran in place, isolation off).
        const syntaxPass = async (
          rows: readonly WorkerTaskResult[],
        ): Promise<WorkerTaskResult[]> => {
          const pending = rows.filter(
            (r) => !gateState.syntaxGated.has(r.id) || gateState.isStale(r.id),
          );
          // Re-checked on the folder from here on.
          gateState.settle(rows.map((r) => r.id));
          if (pending.length === 0) return [...rows];
          const checked = await runSyntaxPass(pending, parsed.tasks, {
            runner: deps.syntaxCheck,
            workingDir: ctx.workingDir,
            roots: syntaxRoots,
            signal: runSignal,
            ...(deps.knownSecrets === undefined
              ? {}
              : { knownSecrets: collectKnownSecrets() }),
          });
          for (const row of checked) {
            if (row.status === "failed" && gateState.syntaxGated.has(row.id)) {
              gateState.verdicts.delete(row.id);
            }
          }
          return rows.map((r) => checked.find((c) => c.id === r.id) ?? r);
        };
        results = await syntaxPass(await evaluateContract(results, results));

        // The judge (ATO-944): a task closes on a green acceptance list, a
        // red list is re-run once with the findings, and a list still red
        // after that is a failed task, item by item. Its spend counts
        // toward the turn's cap.
        if (judging) {
          const judgeRows = async (
            rows: readonly WorkerTaskResult[],
          ): Promise<Map<string, JudgeVerdict>> => {
            const verdicts = new Map<string, JudgeVerdict>();
            for (const row of rows) {
              // Already ruled on in its workspace, before its merge.
              const gated = gateState.verdicts.get(row.id);
              if (gated !== undefined) {
                verdicts.set(row.id, gated);
                continue;
              }
              if (!judgeable(row)) continue;
              const task = parsed.tasks.find((t) => t.id === row.id)!;
              verdicts.set(
                row.id,
                await judgeOne({
                  task,
                  items: acceptance.get(row.id) ?? [],
                  facts: {
                    checkOutcomes,
                    findings: contract?.findings ?? [],
                  },
                  reply: row.reply,
                  contract: parsed.contract,
                  workingDir: ctx.workingDir,
                  // No snapshot of the folder before the wave: file heads.
                  changes: [],
                }),
              );
            }
            return verdicts;
          };
          // Review passes (issue #38): a task its review sends back is
          // re-run with the findings, up to `team.reviewPasses` times with a
          // team (one retry without, as before), each pass only while the
          // turn may go on (budget, cancellation, failure breakers). A pass
          // is in-call, never a replan attempt.
          const verdicts = await judgeRows(results);
          const passes = new Map<string, number>();
          const stopped = new Map<string, string>();
          // A pass that came back unjudgeable (it failed or was cancelled)
          // keeps its own status; the verdict before it stands beside it.
          const unjudged = new Map<string, JudgeVerdict>();
          const needsChanges = (v: JudgeVerdict): boolean => !v.green && v.unverified === undefined;
          const passStop = (): string | undefined => {
            const budget = budgetStop();
            if (budget !== undefined) return budget.message;
            if (ctx.signal.aborted) return "the turn was cancelled";
            if (teamReview === undefined) return undefined;
            if (runSignal.aborted) return "the turn was cancelled";
            for (const breaker of breakers.values()) {
              const reason = breaker.stopReason();
              if (reason !== undefined) return reason;
            }
            return undefined;
          };
          let open = [...verdicts].filter(([, v]) => needsChanges(v)).map(([id]) => id);
          for (let pass = 1; ; pass += 1) {
            open = open.filter((id) => pass <= passLimitFor(id));
            if (open.length === 0) break;
            const stop = passStop();
            if (stop !== undefined) {
              for (const id of open) stopped.set(id, stop);
              break;
            }
            const retryIds = new Set(open);
            const findings = new Map(
              open.map((id) => {
                const verdict = verdicts.get(id)!;
                const items = acceptance.get(id) ?? [];
                const issues = reviewedByTeam(id) ? renderReviewIssues(verdict.review) : undefined;
                return [
                  id,
                  [renderRetryFindings(items, verdict), issues]
                    .filter((part): part is string => part !== undefined)
                    .join("\n\n"),
                ];
              }),
            );
            // The retry keeps the right to split: a task judged red for being
            // too big would only fail again in one piece.
            const retryTasks = parsed.tasks.filter((t) => retryIds.has(t.id));
            // Under isolation the retry works on in the workspace it was
            // judged red in, so its earlier attempt is there to fix; the
            // retry's own gate rules on it before it merges, and keeps the
            // workspace while another pass may follow.
            for (const id of retryIds) gateState.verdicts.delete(id);
            reviewPass = pass;
            const retried = await expandWave(
              retryTasks,
              await runTasks(
                retryTasks,
                contractForWave(parsed.contract, [...waveWarnings]),
                (taskId) =>
                  [waveSuffix?.(taskId), findings.get(taskId)]
                    .filter((part): part is string => part !== undefined)
                    .join("\n\n"),
                true,
              ),
            );
            const merged = results.map(
              (r) => retried.find((x) => x.id === r.id) ?? r,
            );
            // The retried rows, and any task the retry's merges made stale.
            const evaluated = await syntaxPass(
              await evaluateContract(
                merged.filter((r) => retryIds.has(r.id) || gateState.isStale(r.id)),
                merged,
              ),
            );
            results = merged.map(
              (r) => evaluated.find((x) => x.id === r.id) ?? r,
            );
            for (const id of retryIds) passes.set(id, pass);
            const again = await judgeRows(results.filter((r) => retryIds.has(r.id)));
            open = [];
            for (const id of retryIds) {
              const verdict = again.get(id);
              if (verdict === undefined) {
                unjudged.set(id, verdicts.get(id)!);
                verdicts.delete(id);
                continue;
              }
              verdicts.set(id, verdict);
              if (needsChanges(verdict)) open.push(id);
            }
          }
          // The director's view (issue #38): the review on the row, with a team.
          const withReview = (row: WorkerTaskResult, verdict: JudgeVerdict): WorkerTaskResult =>
            !reviewedByTeam(row.id)
              ? row
              : {
                  ...row,
                  review: {
                    decision: verdict.review.decision,
                    passes: passes.get(row.id) ?? 0,
                    reviewer: verdict.review.reviewer,
                    ...(verdict.review.reviewerIdentity === undefined ? {} : { reviewerIdentity: verdict.review.reviewerIdentity }),
                    issues: verdict.review.issues,
                  },
                };
          results = results.map((r) => {
            const before = unjudged.get(r.id);
            if (before !== undefined) {
              return withReview({
                ...r,
                notes: [
                  ...(r.notes ?? []),
                  `judge: ${redItems(before).length} of ${before.items.length} acceptance items were not met before the retry; the retry ended ${r.status} and was not judged`,
                ],
              }, before);
            }
            const verdict = verdicts.get(r.id);
            if (verdict === undefined) return r;
            const ran = passes.get(r.id) ?? 0;
            const byTeam = reviewedByTeam(r.id);
            const row = withReview(applyJudgeVerdict(r, verdict, ran > 0, byTeam ? ran : undefined), verdict);
            if (!byTeam) return row;
            const stop = stopped.get(r.id);
            if (stop !== undefined) {
              return { ...row, notes: [...(row.notes ?? []), `review stopped: ${stop}`] };
            }
            // The passes ran out and the review still asks for changes: the
            // director decides (`describeReplan`'s review-exhausted bucket).
            // An unverified review (no readable answer, the judge could not
            // run) stays as `applyJudgeVerdict` left it.
            if (verdict.review.decision !== "needs-changes" || reviewCutShort.has(r.id)) return row;
            const head = `review-exhausted: ${verdict.review.decision} after ${ran} review pass${ran === 1 ? "" : "es"}`;
            return {
              ...row,
              status: "failed" as const,
              failure: "review-exhausted" as const,
              error: row.error === undefined ? head : `${head}; ${row.error}`,
            };
          });
        }
        // A change must not break a case that already passed (issue #106):
        // every contract check that passed on a reviewed version of this
        // milestone (kept in its runs' criteria.json, whatever task it was
        // for) and that this call's contract does not run itself is run
        // again when a row of the call changed a file. One that fails now
        // fails each row that changed a file, as a regression naming it.
        const regressionChecks = priorPassedChecks();
        const writers = results.filter((r) => (r.attempt?.wrote.length ?? 0) > 0 && r.status !== "failed" && r.status !== "cancelled");
        let reranPassed: Record<string, unknown>[] = [];
        if (regressionChecks.length > 0 && writers.length > 0 && !runSignal.aborted) {
          // Kept as written; a candidate run checks them in its own workspace.
          const toRun = (candidate === undefined
            ? regressionChecks
            : rebaseVerifyWorkspaceValue(regressionChecks, candidateOriginalDir, candidate.dir)) as ContractCheck[];
          const services = [...historicalServices.values()];
          const declarations = [...toRun, ...(candidate === undefined ? services : rebaseVerifyWorkspaceValue(services, candidateOriginalDir, candidate.dir))];
          const regressionRunner = withCheckRun(withCheckDependencies(checkHold.runner, declarations), () => checkRun);
          const rerun = await runContractChecks(toRun, regressionRunner, {
            workingDir: ctx.workingDir, signal: runSignal, filesOf: declaredFilesOf, recordCheckRun,
            ...(deps.knownSecrets === undefined ? {} : { knownSecrets: collectKnownSecrets() }),
          });
          // Held, refused, cancelled or not run: say so on each changed row (issue #106 review).
          const notRun = [
            ...(rerun.checksSkipped === undefined ? [] : [rerun.checksSkipped]),
            ...rerun.outcomes.flatMap((o, i) => (!o.ok && checkDidNotRun(o.detail) ? [`${commandLineOf(regressionChecks[i] as ContractCheck)}: ${o.detail}`] : [])),
          ];
          if (notRun.length > 0) {
            const note = `regression checks not run: ${notRun.join("; ")}; a case that passed on the reviewed version is not known to pass now`;
            const ids = new Set(writers.map((w) => w.id));
            results = results.map((r) => (ids.has(r.id) ? { ...r, notes: [...(r.notes ?? []), note] } : r));
          }
          const broke = rerun.outcomes.flatMap((o, i) => (!o.ok && !checkDidNotRun(o.detail) ? [{ check: regressionChecks[i]!, outcome: o }] : []));
          reranPassed = rerun.outcomes.flatMap((o, i) => (o.ok ? [regressionChecks[i]!] : []));
          // Blame (issue #106 review): a regressed check whose own task changed a
          // file here fails that row; one whose task did not run here fails
          // every changed row, each told which rows are suspected.
          const failing = new Map<string, string[]>();
          for (const { check, outcome } of broke) {
            const owner = typeof check.task === "string" ? writers.find((w) => w.id === check.task) : undefined;
            const blamed = owner !== undefined ? [owner] : writers;
            const suspects = owner !== undefined ? "" : ` (its task did not change a file here; suspected: ${writers.map((w) => w.id).join(", ")})`;
            for (const w of blamed) failing.set(w.id, [...(failing.get(w.id) ?? []), `${commandLineOf(check as ContractCheck)} (${outcome.detail})${suspects}`]);
          }
          results = results.map((r) => {
            const named = failing.get(r.id);
            if (named === undefined) return r;
            const why = `regressed: ${named.join("; ")}: it passed on the reviewed version of the milestone's files and fails now`;
            return { ...r, status: "failed", failure: "regressed-check", error: why, notes: [...(r.notes ?? []), why] };
          });
        }
        // A verify-only task that changed nothing closes only on work
        // already reviewed (issue #104 review): a review recorded by an
        // earlier run on exactly its current files, and its own contract
        // check run by the gate and passed on those same files. Otherwise
        // it stays no_changes: verifyOnly is no way round doing the work.
        results = results.map((r) => {
          if (r.verifyOnlyUnchanged !== true || r.status !== "no_changes") return r;
          const now = declaredHashesNow(r.id);
          const sameFiles = (files: ReadonlyArray<{ path: string; sha256?: string }> | undefined): boolean =>
            files !== undefined && now.length > 0 && files.length === now.length &&
            now.every((f) => f.sha256 !== undefined && files.some((g) => g.path === f.path && g.sha256 === f.sha256));
          const reviewed = priorReviewOf(r.id);
          const ownIndexes = (parsed.contract?.checks ?? []).flatMap((c, i) => (c.task === r.id ? [i] : []));
          const ownOutcomes = ownIndexes.map((i) => latestCheckOutcomes.get(i) ?? gateState.checkOutcomes.get(i));
          const checked = ownIndexes.length > 0 && ownOutcomes.every((o) => o !== undefined && o.ok && sameFiles(o.run?.files));
          if (reviewed !== undefined && sameFiles(reviewed.files) && checked) {
            return { ...r, status: "ok", notes: [...(r.notes ?? []).filter((n) => n !== VERIFY_ONLY_UNCHANGED_NOTE), "verify-only: no file changed; an earlier review is recorded on exactly these files and its own check passed on them"] };
          }
          const why = reviewed === undefined || !sameFiles(reviewed.files)
            ? "no review is recorded on exactly these files"
            : ownIndexes.length === 0 ? "it has no own contract check" : "its own check did not pass on these files";
          return { ...r, notes: [...(r.notes ?? []), `verify-only: stays no_changes: ${why}; an implementation task is re-delegated without verifyOnly to make its change`] };
        });
        // Every task whose checks name criteria has its facts, judged or
        // not: one not ruled green stays open for the director (issue #40).
        {
          const named = briefCriteria ?? new Map<string, { id: string; text: string }>();
          const outcomesByIndex = (parsed.contract?.checks ?? []).map(
            (_, index) => latestCheckOutcomes.get(index) ?? gateState.checkOutcomes.get(index),
          );
          results = results.map((r) => holdOnCriteria(r, taskCriteria(r.id, parsed.contract, named), parsed.contract, outcomesByIndex, criterionRunId));
        }
        // The run's success-criteria facts, kept with its screenshots for
        // the milestone report (issue #40, `run-criteria.ts`). A candidate
        // run's wait for its finish: the folder keeps only what was promoted.
        const runFacts = results.flatMap((r) => (r.criteria === undefined ? [] : [{ taskId: r.id, facts: r.criteria }]));
        // Every task the call meant to review, with its verdict or why it
        // has none (issue #95): a task that ends unreviewed is said so, here
        // and in the milestone report (the run keeps it beside its facts).
        runReviews = judging
          ? results.flatMap((r): RunTaskReview[] => {
              if (!parsed.tasks.some((t) => t.id === r.id) || (acceptance.get(r.id)?.length ?? 0) === 0) return [];
              const decision = r.judge?.review?.decision;
              // A regression stands over any verdict on the changed files (issue #106).
              if (r.failure === "regressed-check") return [{ taskId: r.id, verdict: "none", reason: (r.error ?? "regressed").slice(0, 300) }];
              if (r.judge !== undefined && r.judge.unverified === undefined && (decision === "accept" || decision === "needs-changes")) {
                const reviewer = r.review?.reviewerIdentity ?? r.judge?.review?.reviewerIdentity;
                // A needs-changes keeps its concrete blockers for a targeted
                // fix (issue #100): a blocker naming a file or an item, not a
                // fact whose check never ran (a missing binary is no finding).
                const issues = decision === "needs-changes"
                  ? (r.review?.issues ?? r.judge?.review?.issues ?? [])
                      .filter((i) => i.severity === "blocker" && (i.file !== null || i.item !== null))
                      .filter((i) => i.by !== "fact" || !checkDidNotRun(i.why))
                      .map((i) => ({ severity: "blocker" as const, text: `${i.file === null ? "" : `${i.file}: `}${i.why}` }))
                  : [];
                const files = declaredHashesNow(r.id);
                return [{ taskId: r.id, verdict: decision, ...(reviewer === undefined ? {} : { reviewer }), ...(issues.length === 0 ? {} : { issues }), ...(files.length === 0 ? {} : { files }) }];
              }
              const reason =
                r.judge === undefined
                  ? r.status === "ok"
                    ? "not judged"
                    : `the task ended ${r.status} before review: ${(r.error ?? r.status).replace(/\s+/g, " ").slice(0, 160)}`
                  : `not verified: ${(r.judge.unverified ?? "no decision").replace(/\s+/g, " ").slice(0, 160)}`;
              const criteria = [...new Set((parsed.contract?.checks ?? []).filter((c) => c.task === r.id).flatMap((c) => c.criteria ?? []))];
              return [{ taskId: r.id, verdict: "none", reason, ...(criteria.length === 0 ? {} : { criteria }) }];
            })
          : [];
        // Which tasks this call ran (not those carried from a checkpoint or never started), and whether review was on (issue #98).
        const carriedIds = new Set(resume?.carried.map((r) => r.id) ?? []);
        const ranIds = results.filter((r) => !carriedIds.has(r.id) && !(r.error ?? "").startsWith("not started:")).map((r) => r.id);
        // The checks that passed on a reviewed version, this call's own and the re-run ones, for later fix rounds (issue #106).
        const reviewedIds = new Set(runReviews.filter((v) => v.verdict === "accept" || v.verdict === "needs-changes").map((v) => v.taskId));
        const passedChecks = [
          ...(parsed.contract?.checks ?? []).flatMap((c, i) => {
            const outcome = latestCheckOutcomes.get(i) ?? gateState.checkOutcomes.get(i);
            // Kept as the director wrote it, never as rebased into a candidate's workspace.
            return c.task !== undefined && reviewedIds.has(c.task) && outcome?.ok === true ? [checksAsWritten[i] ?? c] : [];
          }),
          ...reranPassed,
        ];
        runMeta = () => ({ ran: ranIds, judging, ...(passedChecks.length === 0 ? {} : { passedChecks }) });
        noReviewVerdict = runReviews.flatMap((r) => (r.verdict === "none" ? [{ taskId: r.taskId, reason: r.reason! }] : []));
        if (candidate === undefined && evidenceRun !== undefined && deps.runCheckpoints !== undefined) {
          writeRunChangedFiles(deps.runCheckpoints.runsDir, evidenceRun, [...deliveredPaths], mode.isolation !== "worktree");
          writeRunCriteriaFacts(deps.runCheckpoints.runsDir, evidenceRun, runFacts, factCriteria, runReviews, runMeta());
        }
        // Workspaces kept for a retry are done with, retried or not.
        await releaseKept();
        results = await collectTaskArtifactManifests(results, parsed.tasks, {
          workingDir: ctx.workingDir, roots: syntaxRoots, signal: runSignal,
          ...(parsed.contract === undefined ? {} : { contract: parsed.contract }),
          checkOutcomes, findings: contract?.findings ?? [],
          verifiedNoChangesProviders,
        });
        for (const row of results) {
          if (row.artifactManifest === undefined) continue;
          run?.recordArtifactManifest(row.id, row.artifactManifest);
          if (candidate === undefined && row.status === "ok" && !carriedIds.has(row.id)) {
            const manifest = row.artifactManifest;
            writeReceipt("artifact-manifest", () => ({ ...manifest }));
          }
        }
        // Automatic replanning (ATO-941): what did not close, from the
        // facts above, with the attempts it has left. The planner's next
        // step is held to `fusion.delegate` by the loop while any task is
        // pending (`fusion-replan.ts`); exhausted tasks are to be reported.
        // A task waiting for the person's yes after a restart is theirs to
        // decide: held to `fusion.delegate`, the planner could only repeat
        // the commands the question exists to guard.
        const awaitingYes = new Set(
          resume?.needsConfirmation.map((r) => r.id) ?? [],
        );
        // A task whose review passes ran out, or the watch stopped as
        // stuck, goes to the director with replanning off too (issues
        // #38, #43): then only those buckets, with no re-delegation left.
        const fullReplan =
          stoppedBy === undefined &&
          trips.length === 0 &&
          !ctx.signal.aborted &&
          (autoReplan > 0 || results.some((r) => r.failure === "review-exhausted" || r.failure === "stuck"))
            ? describeReplan(
                results.filter((r) => !awaitingYes.has(r.id)),
                (id) => turnBudget.attempts(ctx.sessionId, id),
                autoReplan,
              (id) => turnBudget.ranOnOrchestrator(ctx.sessionId, id),
              // Only steer there while the target is on and under its cap.
              orchestratorLegRef !== undefined &&
                orchestratorCap > 0 &&
                (!tracksTurn ||
                  turnBudget.orchestratorTasks(ctx.sessionId) < orchestratorCap),
              // A plan task is steered to its row's worker, never another model (issue #102).
              // Compared against the row's own member: a row the orchestrator works stays on it.
              (id) => {
                if (!planApproved || projectVerdict.kind !== "admit" || !projectVerdict.planned.includes(id)) return undefined;
                const planRow = ctx.project?.plan?.rows.find((r) => r.taskId === id);
                if (planRow === undefined) return undefined;
                const orchestratorMember = orchestratorLegRef === undefined ? undefined
                  : "member" in orchestratorLegRef ? orchestratorLegRef.member : `${orchestratorLegRef.providerId}:${orchestratorLegRef.model}`;
                return {
                  worker: planRow.worker,
                  orchestrator: orchestratorMember !== undefined && sameMember(planRow.worker, orchestratorMember, deps.resolveDefaultModel),
                };
              },
              )
            : undefined;
        const replan =
          fullReplan === undefined || autoReplan > 0
            ? fullReplan
            : { pending: [], exhausted: [], failedOnOrchestrator: [], reviewExhausted: fullReplan.reviewExhausted, stuck: fullReplan.stuck, max: 0 };
      // How this round's families ended, judged rows included: a family
      // that closed green is no longer one a dotted id can continue.
      if (ranNow.size > 0) {
        turnBudget.noteRoundOutcomes(
          ctx.sessionId,
          results
            .filter((r) => ranNow.has(r.id))
            .map((r) => ({ id: r.id, open: isOpenResult(r) })),
        );
      }
        const contractLine =
          contract === undefined ? undefined : renderContractLine(contract);
        // The run ended here. Stopped by the person or by a quit, its file
        // stays for a resume, and so it does while a task waits for the
        // person's yes: the confirm call resumes from it. Otherwise there
        // is nothing left to resume.
        run?.finish(
          ctx.signal.aborted || (resume?.needsConfirmation.length ?? 0) > 0
            ? "interrupted"
            : "complete",
        );
        // What this turn counted for the run: a resume later in the turn
        // imports only what the cap has not seen (issue #87).
        if (run !== undefined) runAccounting.close(run.runId);
        const resumeNote =
          resume === undefined
            ? ""
            : `\n\nResumed run ${resume.runId}: ${resume.carried.length} task${resume.carried.length === 1 ? "" : "s"} reported from before the restart, ${resume.rerun.length} run again${
                resume.needsConfirmation.length === 0
                  ? ""
                  : `, ${resume.needsConfirmation.length} not run again until the person agrees (${resume.needsConfirmation.map((r) => r.id).join(", ")})`
              }.${directorChange === null ? "" : ` ${resumeDirectorWarning(directorChange)}`}`;
        const checkpointNote = run?.checkpointWarning === undefined ? "" :
          `\n\nThis Fusion run cannot be resumed: ${run.checkpointWarning}. Plan any remaining work again after an interruption.`;

        // A plan reviewer that could not review rides its task's row (issue #74).
        if (planReviewerNotes.size > 0) {
          results = results.map((r) => {
            const note = planReviewerNotes.get(r.id);
            return note === undefined ? r : { ...r, notes: [...(r.notes ?? []), note] };
          });
        }
        // The fit warnings ride their task's row (ATO-1363).
        if (fit.warnings.size > 0) {
          results = results.map((r) => {
            const warning = fit.warnings.get(r.id);
            return warning === undefined
              ? r
              : { ...r, notes: [...(r.notes ?? []), warning] };
          });
        }
        const estimates = estimateRows(
          parsed.tasks,
          results,
          localTokensPerSecond,
          maxWorkers,
        );
        const estimateNote = renderEstimateBlock(estimates);

        // Where each task ran (ATO-943): the model and role on the row, and
        // a note when it is not the worker leg or not where it asked to be.
        // Without roles and without a task naming a model, rows are as before.
        if (mode.roles !== undefined || roleLegs.size > 0 || teamTasks !== undefined) {
          results = results.map((r) => {
            const leg = taskLegs.get(r.id);
            if (leg === undefined) return r;
            const notes = [
              ...(leg.note === undefined ? [] : [leg.note]),
              ...(leg.isWorkerLeg
                ? []
                : [
                    `ran on ${leg.model}${leg.orchestrator === true ? " (the orchestrator's model)" : leg.role === undefined ? "" : ` (role ${leg.role})`}`,
                  ]),
            // A subscription leg has no price: turnBudgetUsd cannot see
            // these turns, only the count cap does.
            ...(leg.orchestrator === true &&
            rolePricing.get(legKey(leg)) === undefined
              ? [
                  "unpriced: counted against llm.runMode.fusion.maxOrchestratorTasksPerTurn, not turnBudgetUsd",
                ]
              : []),
            ];
            return {
              ...r,
              model: leg.model,
              ...(leg.role === undefined ? {} : { modelRole: leg.role }),
              ...(notes.length === 0 ? {} : { notes: [...(r.notes ?? []), ...notes] }),
            };
          });
        }
        // The profile each task ran under (ATO-566), with its source and
        // the tools it left; the shadowed-built-in note rides with it.
        if (profileReports.length > 0) {
          const byTask = new Map(profileReports.map((p) => [p.task, p]));
          results = results.map((r) => {
            const report = byTask.get(r.id);
            if (report === undefined) return r;
            const shadow = shadowedBuiltinNote(report.profile, report.source);
            const notes = (report.notes ?? []).filter((n) => n === shadow);
            return {
              ...r,
              profile: { name: report.profile, source: report.source, tools: report.tools },
              ...(notes.length === 0 ? {} : { notes: [...(r.notes ?? []), ...notes] }),
            };
          });
        }
        let roleSpendUsd = 0;
        for (const [key, pricing] of rolePricing) {
          if (pricing === undefined) continue;
          const leg = roleLegs.get(key)!;
          roleSpendUsd += fanoutSpend(
            results.filter((r) => {
              const own = taskLegs.get(r.id);
              return own !== undefined && !own.isWorkerLeg && legKey(own) === key;
            }),
            pricing,
            leg.providerId,
          ).usd;
        }

        // …and takes the turn back. One line, so the operator can see the
        // spend return to the cloud leg instead of guessing which of the
        // lines above was the last worker.
        const okCount = results.filter((r) => r.status === "ok").length;
        deps.emitEvent(ctx.sessionId, {
          type: "fusion_worker",
          taskId: FUSION_DELEGATE_TOOL,
          title: `${results.length} task${results.length === 1 ? "" : "s"}`,
          phase: "finished",
          role: "orchestrator",
          model: orchestratorModel,
          summary: `${okCount}/${results.length} ok — merging`,
        });

        // When the pool is what held the fan-out down, the orchestrator is
        // the party that can adapt — by splitting differently next time,
        // or by telling the operator which knob to turn. So the note names
        // all three things it needs: what was wanted, what actually ran
        // concurrently, and the config key that changes the second number.
        const hint = poolIsBinding
          ? `\n\nNote: ${legTaskCount} workers' worth of work was sent but the local server has ${poolSize} request slot${poolSize === 1 ? "" : "s"}, so only ${workerLegMaxWorkers} ran at a time and the rest queued. That number comes from the machine — every slot draws on one shared llama-server context pool (\`localModels.managed.parallel\`, \`"auto"\` by default). Split into fewer, larger tasks if the queueing is costing more than the parallelism buys.`
          : cloudCapIsBinding
            ? `\n\nNote: ${parsed.maxWorkers === undefined ? `the default width of ${mainWanted} (\`llm.runMode.fusion.workers\`; this call named no maxWorkers)` : `maxWorkers ${mainWanted}`} was clamped to ${workerLegMaxWorkers}, the cloud worker cap (\`llm.runMode.fusion.cloudWorkers\`)${roleLegs.size === 0 ? "" : " on the main worker leg"}; the rest queued behind them.`
            : parsed.maxWorkers !== undefined && maxWorkers < wanted
              ? `\n\nNote: maxWorkers ${wanted} was clamped to ${maxWorkers} across the active provider pools by their slot, cloud-worker and strong-model limits; the rest queued behind them.`
              : "";
        // The call's own status is the tasks' summary: a fan-out where
        // every worker failed used to come back `ok`, and an orchestrator
        // reading only the status merged nothing as if it were something.
        // Workers that were never served or timed out before a single step
        // count as nothing delivered too (ATO-234).
        const candidateReport = candidate === undefined ? undefined : await candidate.finish({
          rows: results,
          tasks: parsed.tasks,
          contract: parsed.contract,
          runChecks: withCheckDependencies(checkHold.finalRunner),
          holdChecks: deps.runChecks === undefined
            ? undefined
            : (signal) => checkHold.decide(signal, contractChecksAllowedByEgress((parsed.contract?.checks ?? []).filter(check => (check.kind ?? check.type) !== "ui"), checkEgress)),
          signal: runSignal,
          recordCheckRun,
        });
        completedCandidateReport = candidateReport;
        if (candidateReport?.status === "promoted" && candidateReport.artifactManifest !== undefined) {
          const manifest = candidateReport.artifactManifest;
          writeReceipt("artifact-manifest", () => ({ ...manifest }));
        }
        // A candidate that was not promoted delivered nothing to the folder
        // (issue #74): none of its criteria stands as passed there.
        if (candidateReport !== undefined && evidenceRun !== undefined && deps.runCheckpoints !== undefined) {
          const why = `candidate not promoted${candidateReport.reason === undefined ? "" : `: ${candidateReport.reason}`}`;
          if (candidateReport.status === "promoted") {
            writeRunChangedFiles(deps.runCheckpoints.runsDir, evidenceRun, candidateReport.changes);
          }
          writeRunCriteriaFacts(
            deps.runCheckpoints.runsDir,
            evidenceRun,
            candidateReport.status === "promoted"
              ? runFacts
              : runFacts.map((t) => ({
                  taskId: t.taskId,
                  facts: t.facts.map((f) => (f.state === "passed" ? { id: f.id, state: "unverified" as const, why } : f)),
                })),
            factCriteria,
            runReviews,
            runMeta(),
          );
        }
        terminalTaskCount = results.length;
        const outcome = delegateOutcome(results);
        // The outcome log and the turn receipt (counts only, never the
        // brief, the reply or an error's words). A task kept from
        // starting never ran on its model and is left out.
        try {
          const ran = results.filter((r) => ranNow.has(r.id) && !(r.error ?? "").startsWith("not started:"));
          const now = new Date();
          const outcomeRows = outcomeRowsFor(ran, now);
          // Final candidate disposition is telemetry, never individual task quality credit.
          candidateOutcomesRecorded = candidate !== undefined;
          deps.outcomeLog?.append(outcomeRows.map(({ record, row }) => candidateReport === undefined ? record
            : withCandidateOutcome(record, candidateReport.acceptanceReceipt!, candidateReport.contract?.checks ?? [], row.id, candidateWorkerRuns.get(row.id))));
          deps.turnLedger?.noteFanout(ctx.sessionId, {
            tasks: outcomeRows.map(({ row, record, pricing }) => ({
              ok: row.status === "ok",
              tokens: (row.usage?.promptTokens ?? 0) + (row.usage?.completionTokens ?? 0),
              durationMs: row.durationMs,
              costUsd: rowCostUsd(row, pricing),
              orchestrator: record.leg === "orchestrator",
            })),
            wallMs: now.getTime() - fanoutStartedAt,
            judgeCostUsd: judgeSpendUsd,
            escalationCostUsd: escalationSpendUsd,
          });
        } catch (err) {
          deps.logger.warn("fusion: the fan-out's outcomes were not recorded", {
            reason: err instanceof Error ? err.message : String(err),
          });
        }
        // What the fan-out cost on the worker leg, when its model is priced
        // (a cloud leg with a catalogue entry); a local leg resolves to no
        // pricing and the header says nothing.
        const spend =
          workerPricing === undefined
            ? null
            : fanoutSpend(
                roleLegs.size === 0
                  ? results
                  : results.filter(
                      (r) => taskLegs.get(r.id)?.isWorkerLeg !== false,
                    ),
                workerPricing,
                workerModel,
              );
        // The task tree, when any worker proposed a split (ATO-940); the
        // children themselves are summarised in their parent's block.
        const treeReport = tree?.report();
        const treeNote =
          treeReport === undefined ||
          treeReport.splits + treeReport.rejected === 0
            ? ""
            : `\n\nTask tree: ${treeReport.splits} task${treeReport.splits === 1 ? "" : "s"} split by their workers, ${treeReport.rejected} proposal${treeReport.rejected === 1 ? "" : "s"} refused, ${treeReport.nodes} of ${treeReport.maxNodes} nodes used (depth limit ${treeReport.maxDepth}).`;
        // In-flight completions and post-wave checks/judging may have
        // settled since the first stop. Report the final totals.
        budgetStopped = budgetStop() ?? stoppedBy;
        const budgetNote =
          budgetStopped === undefined
            ? ""
            : `\n\nStopped: ${budgetStopped.message}. ${TURN_BUDGET_INSTRUCTION}`;
        const breakerNote =
          trips.length === 0
            ? ""
            : `\n\nStopped: ${trips.map(describeTrip).join("; ")}. ${FAILURE_BREAKER_INSTRUCTION}`;
        const result = compressToolResult(
          {
            tool: FUSION_DELEGATE_TOOL,
            status: outcome === "all_failed" ? "error" : "ok",
            output: `${formatDelegateOutput(results, deps.outputCharCap, {
              ...(contractLine === undefined ? {} : { contractLine }),
              spend,
              ...(ordered ? { waves: plan.waves } : {}),
              // A green row of these shows its reply's first line only.
              declaredFiles: new Set(
                parsed.tasks
                  .filter((t) => (t.files?.length ?? 0) > 0)
                  .map((t) => t.id),
              ),
            })}${hint}${schedulerWaitNote(results)}${fit.plannerNote ?? ""}${estimateNote}${
              escalationSpendUsd > 0
                ? `\n\nEscalations to ${escalationTarget?.model ?? escalationTarget?.providerId ?? "the escalation model"} cost ${formatUsd(escalationSpendUsd)} this fan-out (each worker's row says what for).`
                : ""
            }${
              judgeSpendUsd > 0
                ? `\n\n${judgeSpendLine([...judgesUsed])} cost ${formatUsd(judgeSpendUsd)} this fan-out.`
                : ""
            }${
              roleSpendUsd > 0
                ? `\n\nRole models cost ${formatUsd(roleSpendUsd)} this fan-out.`
                : ""
            }${
              noReviewVerdict.length === 0
                ? ""
                : `\n\nno review verdict: ${noReviewVerdict.map((n) => `${n.taskId} (${n.reason})`).join("; ")}. To get one, re-delegate each with its own task id (the plan row's): a fix under another id does not count.`
            }${treeNote}${replan === undefined ? "" : renderReplanBlock(replan)}${renderMergeBlock(merges)}${resumeNote}${checkpointNote}${budgetNote}${breakerNote}${
              sizeWarnings.length === 0
                ? ""
                : `\n\nWarning: ${sizeWarnings.join("; ")}.`
            }`,
            details: {
              tasks: results,
              ...(noReviewVerdict.length === 0 ? {} : { noReviewVerdict }),
              ...(routing === undefined ? {} : { routing: routing.decisions }),
              outcome,
              maxWorkers,
              requestedWorkers: requested,
              ...(Number.isFinite(poolSize) ? { slotPoolSize: poolSize } : {}),
              // The wave plan, for the orchestrator and the trace's tool
              // row alike — only when the contract ordered anything.
              ...(ordered ? { waves: plan.waves } : {}),
              ...(contract === undefined ? {} : { contract }),
              ...(spend === null ? {} : { workerSpendUsd: spend.usd }),
              ...(escalationSpendUsd > 0 ? { escalationSpendUsd } : {}),
              ...(judgeSpendUsd > 0 ? { judgeSpendUsd } : {}),
              ...(roleSpendUsd > 0 ? { roleSpendUsd } : {}),
              ...(estimates.length === 0 ? {} : { estimates }),
              ...(fit.oversized.length === 0
                ? {}
                : { oversizedTasks: fit.oversized }),
              // Every reviewed task's review in full (issue #38); the row's
              // `review:` clause names at most five issues.
              ...(results.some((r) => r.review !== undefined)
                ? {
                    review: Object.fromEntries(
                      results.flatMap((r) => (r.review === undefined ? [] : [[r.id, r.review]])),
                    ),
                  }
                : {}),
              // Every watched task's counts (issue #43); the row's `watch:`
              // clause shows only hints and a stop.
              ...(results.some((r) => r.watch !== undefined)
                ? {
                    watch: Object.fromEntries(
                      results.flatMap((r) => (r.watch === undefined ? [] : [[r.id, r.watch]])),
                    ),
                  }
                : {}),
              ...(profileReports.length === 0 ? {} : { profiles: profileReports }),
              ...(merges.length === 0 ? {} : { merges }),
              ...(replan === undefined ||
            (replan.pending.length === 0 &&
              replan.exhausted.length === 0 &&
              replan.failedOnOrchestrator.length === 0 &&
              replan.reviewExhausted.length === 0 &&
              replan.stuck.length === 0)
                ? {}
                : { replan }),
              ...(treeReport === undefined ? {} : { taskTree: treeReport }),
              ...(sizeWarnings.length === 0 ? {} : { sizeWarnings }),
              ...(run === undefined ? {} : run.checkpointWarning === undefined
                ? { runId: run.runId } : { checkpointWarning: run.checkpointWarning }),
              ...(results.some(r => r.artifactManifest !== undefined) ? {
                artifactManifests: Object.fromEntries(results.flatMap(r => r.artifactManifest === undefined ? [] : [[r.id, r.artifactManifest]])),
              } : {}),
              ...(resume === undefined
                ? {}
                : {
                    resume: {
                      runId: resume.runId,
                      carried: resume.carried.map((r) => r.id),
                      rerun: resume.rerun,
                      needsConfirmation: resume.needsConfirmation.map(
                        (r) => r.id,
                      ),
                      carriedSpendUsd: resume.carriedSpendUsd,
                      ...(directorChange === null ? {} : { director: directorChange }),
                    },
                  }),
              ...(budgetStopped === undefined
                ? {}
                : {
                    turnBudget: {
                      kind: budgetStopped.kind,
                      spentUsd: budgetStopped.spentUsd,
                      elapsedMs: budgetStopped.elapsedMs,
                      ...(budgetStopped.conservativeUsd === undefined ? {} : { conservativeUsd: budgetStopped.conservativeUsd }),
                    },
                  }),
            },
          },
          { maxSummaryLength: deps.outputCharCap + 400, maxTailLines: 2000 },
        );
        try {
          const outputKnownSecrets = collectKnownSecrets();
          return candidateReport === undefined ? projectFusionArtifactEvidence(result, deps.outputCharCap, { knownSecrets: outputKnownSecrets }) : candidateToolResult(result, candidateReport, candidate!.dir, candidateOriginalDir, deps.outputCharCap, outputKnownSecrets);
        } catch {
          return terminalMetadataUnavailable(candidateReport, terminalTaskCount, deps.outputCharCap, outcome === "all_failed" ? "error" : "ok");
        }
      } finally {
        if (budgetTimer !== undefined) clearTimeout(budgetTimer);
        // Kept workspaces (a judged-red task's, for its retry) are removed
        // whatever happens after the waves: a throw in the retry, the
        // contract pass, the syntax pass or the judge included.
        endLiveFanout();
        await releaseKept();
      }
      } catch (err) {
        if (candidate === undefined) throw err;
        if (completedCandidateReport !== undefined) return terminalMetadataUnavailable(completedCandidateReport, terminalTaskCount, deps.outputCharCap);
        const report = await candidate.reject(`candidate interrupted: ${err instanceof Error ? err.message : String(err)}`);
        try { recordCandidateInterruption?.(report); } catch (recordError) {
          deps.logger.warn("fusion: interrupted candidate outcomes were not recorded", { reason: recordError instanceof Error ? recordError.message : String(recordError) });
        }
        try {
          return candidateToolResult(error("candidate fan-out interrupted", { reason: "candidate-interrupted" }), report, candidate.dir, candidateOriginalDir, deps.outputCharCap, collectKnownSecrets());
        } catch {
          return terminalMetadataUnavailable(report, completedCandidateRows.size, deps.outputCharCap);
        }
      } finally {
        await candidate?.cleanup();
      }
  }
}

/** A fan-out's project admission (issue #39): the approved milestone it runs, and whether any worker started. */
interface FanoutAdmission {
  milestoneId: string | null;
  started: boolean;
  /** The run whose folder holds the fan-out's evidence (its checkpoint's, or a candidate run's; issue #74). */
  runId?: string;
  runStartedAt?: number;
}

/**
 * The project update a fan-out of an approved milestone hands back
 * (issue #39): `milestone_run` with the run's id (the checkpoint's, or
 * a candidate run's evidence folder, issue #74; a fresh id only when
 * there is no run store), which the step commit folds to mark
 * the milestone in progress and remember the run. A fan-out whose workers
 * ran is recorded even when it failed (every task failed, an interrupted
 * run), so the milestone shows the work started and the run to resume;
 * one refused or failed before any worker ran records nothing.
 */
/** A check runner that counts each spec it runs, by check identity, into `counts` (issue #106 review). */
function countGateRuns(runner: ContractCheckRunner | undefined, counts: Map<string, number>): ContractCheckRunner | undefined {
  if (runner === undefined) return undefined;
  const wrapped = (specs: Parameters<ContractCheckRunner>[0], ctx: Parameters<ContractCheckRunner>[1]): ReturnType<ContractCheckRunner> => {
    for (const spec of specs) {
      const key = checkSpecKey(spec as Record<string, unknown>);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return runner(specs, ctx);
  };
  return Object.assign(wrapped, runner.supportsInputIntegrity === true ? { supportsInputIntegrity: true as const } : {});
}

function withMilestoneRun(result: CompressedToolResult, admitted: FanoutAdmission): CompressedToolResult {
  const milestoneId = admitted.milestoneId;
  if (milestoneId === null || (result.status !== "ok" && !admitted.started)) return result;
  const runId =
    admitted.runId ??
    (typeof result.details.runId === "string" ? result.details.runId : `fanout-${Date.now().toString(36)}`);
  const update: ProjectUpdate = {
    kind: "milestone_run", id: milestoneId, runId,
    ...(admitted.runStartedAt === undefined ? {} : { startedAt: admitted.runStartedAt }),
  };
  const next: CompressedToolResult = { ...result, details: { ...result.details, projectUpdate: update } };
  // Keep the non-enumerable full output the result may carry.
  for (const key of ["fullOutput", "fullOutputTruncated"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(result, key);
    if (descriptor !== undefined) Object.defineProperty(next, key, descriptor);
  }
  return next;
}

/** Rebase parsed JSON strings without changing path escaping or task identities. */
function rebaseCandidateValue<T>(value: T, roots: readonly string[], to: string): T {
  if (typeof value === "string") return rebaseText(value, roots, to) as T;
  if (Array.isArray(value)) return value.map(item => rebaseCandidateValue(item, roots, to)) as T;
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [rebaseText(key, roots, to), rebaseCandidateValue(item, roots, to)])) as T;
  return value;
}

/** Rendering failures cannot revoke a completed file transaction or reveal unmasked source prose. */
function terminalMetadataUnavailable(report: CandidateIntegrationReport | undefined, taskCount: number, cap: number, directStatus: "ok" | "error" = "error"): CompressedToolResult {
  const status = report === undefined ? directStatus : report.status === "promoted" ? "ok" : "error";
  const text = report === undefined ? "Fan-out completed; final metadata unavailable." : report.status === "promoted"
    ? "Candidate promoted; final metadata unavailable." : "Candidate rejected; final metadata unavailable.";
  const summary = text.slice(0, Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : text.length);
  const result: CompressedToolResult = { tool: FUSION_DELEGATE_TOOL, status, summary, truncated: summary.length < text.length,
    details: { metadataUnavailable: true, taskCount: Math.min(1_000_000, taskCount), ...(report === undefined ? {} : {
      candidateIntegration: { status: report.status, nonResumable: true, metadataUnavailable: true, changesCount: Math.min(100_000, report.changes.length) },
    }) } };
  Object.defineProperty(result, "fullOutput", { value: summary, enumerable: false });
  Object.defineProperty(result, "fullOutputTruncated", { value: result.truncated, enumerable: false });
  return result;
}

function candidateToolResult(result: CompressedToolResult, report: CandidateIntegrationReport, candidateDir: string, originalDir: string, cap: number, knownSecrets?: readonly KnownSecret[]): CompressedToolResult {
  // Issue #29: a rejected candidate's files are named, so a cancelled
  // task's new file missing from the folder does not read as a deletion.
  const notApplied = report.status === "rejected" && report.changes.length > 0
    ? ` Not applied to the folder: ${report.changes.slice(0, 10).join(", ")}${report.changes.length > 10 ? ` and ${report.changes.length - 10} more` : ""}.`
    : "";
  const note = report.status === "promoted" ? "Candidate promoted after final integration checks." : `Candidate rejected; file promotion did not complete. ${report.reason ?? ""}${notApplied}`;
  const recovery = (report.patch === undefined ? "" : ` Changes retained at ${report.patch.path}${report.patch.filesDir === undefined ? "" : ` and ${report.patch.filesDir}`}.`) + (report.retainedWorkspace === undefined ? "" : ` Recovery workspace retained at ${report.retainedWorkspace}; remove it manually after recovery.`) + (report.heldArtifactsDir === undefined ? "" : ` Held task artifacts: ${report.heldArtifactsDir}.`) + (report.rollbackConflicts === undefined ? "" : ` Rollback left these concurrently changed or unwritable paths for review: ${report.rollbackConflicts.join(", ")}.`) + (report.ignoredChanges === undefined ? "" : ` Ignored or disposable paths kept private to the candidate, never promoted: ${report.ignoredChanges.join(", ")}.`);
  const details = rebaseCandidateValue(result.details, [candidateDir, candidateDir.replace(/\\/g, "/")], originalDir);
  delete details.runId;
  const checkedRecovery = report.retainedCheckedWorkspace === undefined ? "" : ` Checked recovery workspace retained at ${report.retainedCheckedWorkspace}; remove it manually after recovery.`;
  return projectFusionArtifactEvidence(compressToolResult({ tool: result.tool, status: report.status === "rejected" ? "error" : result.status, output: `${note}${recovery}${checkedRecovery} Candidate mode is non-resumable.\n\n${rebaseText(result.fullOutput ?? result.summary, [candidateDir, candidateDir.replace(/\\/g, "/")], originalDir)}`, details: { ...details, candidateIntegration: report } }, { maxSummaryLength: cap + 800, maxTailLines: 2000 }), cap, { knownSecrets });
}

/**
 * What this round adds to the turn, for the fan-out's approval line
 * (ATO-1406): the round number and the tasks so far, each against its
 * cap when one is on. A subscription leg has no price to show, so the
 * count is what the person weighs before saying yes.
 */
export function describeTurnCounts(
  before: { rounds: number; tasks: number },
  taskCount: number,
  mode: Pick<ResolvedRunMode, "maxRoundsPerTurn" | "maxTasksPerTurn">,
): string {
  const round = before.rounds + 1;
  const tasks = before.tasks + taskCount;
  const roundCap =
    mode.maxRoundsPerTurn === undefined ? "" : ` of at most ${mode.maxRoundsPerTurn}`;
  const taskCap =
    mode.maxTasksPerTurn === undefined ? "" : ` of at most ${mode.maxTasksPerTurn}`;
  return ` (round ${round}${roundCap} this turn, ${tasks} task${tasks === 1 ? "" : "s"}${taskCap} in all)`;
}

/**
 * The arguments a checkpoint replays: the call's own, without the
 * resume keys, so a resumed run's file still describes the run.
 */
function checkpointArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).filter(([key]) => key !== "resume" && key !== "confirm"),
  );
}

/** Judges named on the spend line, at most this many before "+N more". */
const SPEND_LINE_JUDGES = 3;

/** "The judge (x)" or "The judges (x, y, +2 more)". */
function judgeSpendLine(labels: readonly string[]): string {
  const shown = labels.slice(0, SPEND_LINE_JUDGES);
  const more = labels.length - shown.length;
  const names = [...shown, ...(more > 0 ? [`+${more} more`] : [])].join(", ");
  return `The judge${labels.length === 1 ? "" : "s"} (${names})`;
}
