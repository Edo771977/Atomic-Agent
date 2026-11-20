import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { sanitizeModelAlias } from "../../analytics/sanitize-model-alias.js";
import { reportedCostUsd } from "../../llm/provider/usage-cost.js";
import { classifyWorkerFailure } from "./failure-breaker.js";
import { tryAcquireOutcomeLock } from "./outcome-log-lock.js";
import type { CandidateOutcomeEvidence } from "./candidate-outcomes.js";
import type { ReviewDecision } from "./judge.js";
import {
  taskSpendUsd,
  type WorkerPricing,
  type WorkerTaskResult,
  type WorkerTaskStatus,
} from "./worker-result.js";

/**
 * The fusion outcome log: one NDJSON line per finished worker task and
 * one per fusion turn, under `<stateDir>/fusion/outcomes.ndjson`, so
 * `atomic-agent fusion report` can answer "is my local worker model good
 * enough, and what does the strong side cost?".
 *
 * Counts and categories only. No prompt, reply, instruction, title, task
 * id, path or error text is written: a failure is a category from a
 * fixed list (`failureCategory`), a session is a short one-way hash
 * (`sessionTag`), a model is the configured provider id and model label
 * (a local file path cut to its base name, `outcomeLabel`).
 * The file is bounded (`OUTCOME_LOG_MAX_BYTES`, `OUTCOME_LOG_KEEP`
 * rotated files) and a failed write is logged and dropped: the log never
 * fails a fan-out or a turn.
 */

export const FUSION_OUTCOMES_DIR_NAME = "fusion";
export const FUSION_OUTCOMES_FILE_NAME = "outcomes.ndjson";
/** The live file rotates once an append would take it past this. */
export const OUTCOME_LOG_MAX_BYTES = 5 * 1024 * 1024;
/** Rotated files kept (`outcomes.ndjson.1` newest … `.N` oldest). */
export const OUTCOME_LOG_KEEP = 2;
/** Orchestrator steps listed per turn line; a longer turn keeps the first ones. */
export const TURN_STEPS_RECORDED = 100;
/** The record shape's version, for a reader that meets an older file. */
export const OUTCOME_RECORD_VERSION = 1;

/** Where a task ran: the local worker leg, a cloud leg, or the orchestrator's own leg. */
export type OutcomeLeg = "local" | "cloud" | "orchestrator";

export type JudgeOutcome = "green" | "red" | "unverified" | "off";

/** Under `isolation: "worktree"`: what became of the task's workspace. */
export type MergeOutcome = "merged" | "conflict" | "held";

/**
 * Why a task did not come back green, from a fixed list. A non-`ok`
 * status other than `failed` is its own category; a `failed` row is the
 * failure breaker's blocker class when it has one, else what demoted it.
 */
export type FailureCategory =
  | Exclude<WorkerTaskStatus, "ok" | "failed">
  | "tool-protocol"
  | "cli-missing"
  | "not-signed-in"
  | "out-of-credit"
  | "syntax"
  | "checks"
  | "judge-red"
  | "review-exhausted"
  | "stuck"
  | "not-started"
  | "error";

/**
 * The per-task review's last verdict as counts (issue #38): the decision,
 * the extra worker passes it caused, the reviewer's `outcomeLabel` (null:
 * no model reviewed, e.g. a red fact decided) and the issues per severity.
 * Never an issue's text, item or file.
 */
export interface ReviewOutcome {
  decision: ReviewDecision;
  passes: number;
  reviewer: string | null;
  blockers: number;
  majors: number;
  minors: number;
}

/**
 * The periodic watch on a task (issue #43) as counts: checks made, judge
 * calls, hints delivered, whether it stopped the task, and the judge's
 * `outcomeLabel` (null: none named). Never a hint's text.
 */
export interface WatchOutcome {
  checks: number;
  judgeCalls: number;
  hints: number;
  stopped: boolean;
  judge: string | null;
}

/**
 * A task's success criteria after its checks and the vision judgement
 * (issue #40), as counts of the criteria its checks name. Never a text.
 */
export interface CriteriaOutcome {
  passed: number;
  failed: number;
  unverified: number;
}

/** A task's played games (issue #40): how many, how many errors, the median game time. */
export interface GamesOutcome {
  n: number;
  errors: number;
  medianMs: number;
}

export interface TaskOutcomeRecord {
  v: number;
  type: "task";
  /** ISO time the fan-out finished. */
  ts: string;
  /** `sessionTag` of the orchestrator's session. */
  session: string;
  /**
   * The task's id in the fan-out (issue #95), the key a report joins to
   * the plan's rows; written only when it is a short identifier
   * (`OUTCOME_ID_PATTERN`). Absent on older records.
   */
  taskId?: string;
  /** The project plan milestone the task's plan row belongs to, when the plan has one (issue #95). */
  milestoneId?: string;
  provider: string;
  model: string;
  leg: OutcomeLeg;
  /** The role that picked the model, `"orchestrator"` for that target, else null. */
  role: string | null;
  /** Requested task role, independently of the execution leg's role. */
  taskRole?: string | null;
  /** Objective declared checks only; neither judge/self-report nor full integration acceptance. */
  acceptance?: "checks-passed" | "checks-failed";
  acceptanceScope?: "task-checks";
  /**
   * How many contract checks were attributed to this task (issue #30).
   * 0 is "no checks declared", the report's `no-checks`; absent on
   * older records, which stay `unverified`.
   */
  taskChecks?: number;
  /**
   * Telemetry only, never acceptance: the worker's own last `verify.run`
   * was one of this task's declared checks, with the identical spec, and
   * passed after its last change in its workspace. Absent on older records.
   */
  selfCheckPassed?: boolean;
  /** Final candidate disposition and own-check telemetry, never direct quality evidence. */
  candidate?: CandidateOutcomeEvidence;
  /** SHA256 of known configured request identity, stable through execution; not served-model attestation. */
  routingIdentity?: string;
  status: WorkerTaskStatus;
  failure: FailureCategory | null;
  /** This turn's attempt at the task (1 = first), replans and re-delegations alike. */
  attempt: number;
  /** The judge re-ran the task with its findings: a judge retry, or a review pass (`review.passes > 0`). */
  judgeRetried: boolean;
  /** Absent when no per-task review ran, and on older records (`readReviewOutcome`). */
  review?: ReviewOutcome;
  /** Absent when no watch ran, and on older records (`readWatchOutcome`). */
  watch?: WatchOutcome;
  /** Issue #40; absent when no check named a criterion, and on older records (`readCriteriaOutcome`). */
  criteria?: CriteriaOutcome;
  /** Issue #40; absent when no game check ran, and on older records (`readGamesOutcome`). */
  games?: GamesOutcome;
  /** Issue #40: screenshots its checks stored; absent when none, and on older records (`readShotsOutcome`). */
  shots?: number;
  selfCheckNotice: boolean;
  escalations: number;
  judge: JudgeOutcome;
  syntaxDemoted: boolean;
  steps: number;
  /**
   * Work time, ms: wall time less the wait for the server's first token
   * and for the operator's approval of the worker's checks (issue #30).
   * Older records without `wallMs` wrote the wall time here.
   */
  durationMs: number;
  /** Wall time, ms, start to finish; absent on older records. */
  wallMs?: number;
  tokensIn: number;
  tokensOut: number;
  /** Of `tokensIn`, served from a prompt cache; null when not reported. */
  cachedTokens: number | null;
  /** Null when the leg has no price and the service sent no bill. */
  costUsd: number | null;
  /** Null without isolation. */
  merge: MergeOutcome | null;
}

export interface TurnOutcomeRecord {
  v: number;
  type: "turn";
  ts: string;
  session: string;
  orchestrator: {
    /** The provider that served the turn's last orchestrator step. */
    provider: string;
    model: string;
    requests: number;
    tokensIn: number;
    tokensOut: number;
    /** Null when no step reported a cache figure. */
    cachedTokens: number | null;
    /**
     * The orchestrator's requests plus the judge and escalation calls;
     * null when none of them was priced.
     */
    costUsd: number | null;
    /** The requests alone; null when unpriced (a subscription CLI leg). */
    requestCostUsd: number | null;
    judgeCostUsd: number;
    escalationCostUsd: number;
    /** Per orchestrator step: prompt tokens and cache hits (null: not reported). */
    steps: Array<{ in: number; cached: number | null }>;
  };
  fanouts: number;
  /** Every task that ran, worker and orchestrator legs alike. */
  tasks: { total: number; ok: number; failed: number };
  /**
   * Of those, the `model: "orchestrator"` tasks: strong-side spend (null
   * when unpriced), kept out of the worker figures. Their own `"task"`
   * records carry the same cost.
   */
  orchestratorTasks: { total: number; costUsd: number | null };
  /** Worker-leg tasks' tokens. */
  workerTokens: number;
  workerMs: number;
  /** Priced worker-leg spend; null when no worker row was priced. */
  workerCostUsd: number | null;
}

export type OutcomeRecord = TaskOutcomeRecord | TurnOutcomeRecord;

/**
 * A short, one-way tag for a session id: enough to group a session's
 * lines, nothing that names it. Traces key files by the raw id; this
 * log is meant to be read (and shared) as an aggregate, so it does not.
 */
export function sessionTag(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 12);
}

const MODEL_FILE_EXTENSION = /\.(?:gguf|ggml|bin|safetensors|onnx|pt|pth)$/i;

/**
 * A model or provider label safe to write: configured text kept as is,
 * unless it reads as a local file path (a llama-server model set to
 * `/home/alice/models/x.gguf`), which keeps only the file's base name,
 * without its model-file extension, normalised by `sanitizeModelAlias`.
 * Path-like: a backslash; a leading `/`, `~`, `.` or drive letter; more
 * than one `/`; or a model-file extension. A single-slash `vendor/model`
 * id is a model id, not a path.
 */
export function outcomeLabel(value: string): string {
  const pathLike =
    value.includes("\\") ||
    /^(?:[/~.]|[A-Za-z]:)/.test(value) ||
    value.split("/").length > 2 ||
    MODEL_FILE_EXTENSION.test(value);
  if (!pathLike) return value;
  const base = value.split(/[/\\]/).filter((part) => part.length > 0).pop() ?? "";
  return sanitizeModelAlias(base.replace(MODEL_FILE_EXTENSION, "")) ?? "local-model";
}

/** The category a non-green row is counted under; null for `ok`. */
export function failureCategory(
  row: Pick<WorkerTaskResult, "status" | "error" | "syntax" | "checks" | "judge" | "failure">,
): FailureCategory | null {
  if (row.status === "ok") return null;
  if (row.status !== "failed") return row.status;
  if ((row.error ?? "").startsWith("not started:")) return "not-started";
  if (row.failure === "review-exhausted") return "review-exhausted";
  if (row.failure === "stuck") return "stuck";
  const cls = classifyWorkerFailure(row);
  if (cls?.blocker === true) {
    return cls.signature.slice("blocker:".length) as FailureCategory;
  }
  if ((row.syntax?.failedFiles.length ?? 0) > 0) return "syntax";
  if ((row.checks?.failed ?? 0) > 0) return "checks";
  if (row.judge !== undefined && !row.judge.green) return "judge-red";
  return "error";
}

export function judgeOutcome(row: Pick<WorkerTaskResult, "judge">): JudgeOutcome {
  if (row.judge === undefined) return "off";
  if (row.judge.unverified !== undefined) return "unverified";
  return row.judge.green ? "green" : "red";
}

/** What the delegate knows about one task's leg and attempt. */
export interface TaskOutcomeContext {
  provider: string;
  model: string;
  leg: OutcomeLeg;
  role: string | null;
  taskRole?: string | null;
  routingIdentity?: string;
  /** The task's plan milestone (the approved project plan's row), when known (issue #95). */
  milestoneId?: string;
  attempt: number;
  pricing: WorkerPricing | undefined;
  merge: MergeOutcome | null;
  /** Contract checks attributed to the task; absent: unknown (no `taskChecks` written). */
  taskChecks?: number;
  /** The per-task review (`reviewOutcome`); absent: review off, no `review` written. */
  review?: ReviewOutcome;
  /** Issue #40 counts (`criteriaOutcome`, `gamesOutcome`, `shotsOutcome`); each absent: not written. */
  criteria?: CriteriaOutcome;
  games?: GamesOutcome;
  shots?: number;
}

const REVIEW_DECISIONS: ReadonlySet<string> = new Set<ReviewDecision>(["accept", "needs-changes", "unverified"]);

/** A review verdict and its pass count as the record's counts; the reviewer label made safe to write. */
export function reviewOutcome(
  verdict: {
    decision: ReviewDecision;
    reviewer: string | null;
    issues: ReadonlyArray<{ severity: "blocker" | "major" | "minor" }>;
  },
  passes: number,
): ReviewOutcome {
  const count = (severity: string): number => verdict.issues.filter((i) => i.severity === severity).length;
  return {
    decision: verdict.decision,
    passes: Number.isFinite(passes) ? Math.max(0, Math.floor(passes)) : 0,
    reviewer: verdict.reviewer === null ? null : outcomeLabel(verdict.reviewer),
    blockers: count("blocker"),
    majors: count("major"),
    minors: count("minor"),
  };
}

/** A record's review, or undefined when it has none (review off, an older record) or one this reader cannot trust. */
export function readReviewOutcome(row: TaskOutcomeRecord): ReviewOutcome | undefined {
  const review: unknown = (row as { review?: unknown }).review;
  if (typeof review !== "object" || review === null) return undefined;
  const r = review as Record<string, unknown>;
  const count = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;
  if (typeof r.decision !== "string" || !REVIEW_DECISIONS.has(r.decision) || !count(r.passes) ||
    !(r.reviewer === null || typeof r.reviewer === "string") ||
    !count(r.blockers) || !count(r.majors) || !count(r.minors)) return undefined;
  return {
    decision: r.decision as ReviewDecision,
    passes: r.passes,
    reviewer: r.reviewer,
    blockers: r.blockers,
    majors: r.majors,
    minors: r.minors,
  };
}

const wholeCount = (value: unknown): number => (Number.isFinite(value) ? Math.max(0, Math.floor(value as number)) : 0);

/** A row's watch as the record's counts; the judge label made safe to write. */
export function watchOutcome(watch: {
  checks: number;
  judgeCalls: number;
  hints: number;
  stopped: boolean;
  judge: string | null;
}): WatchOutcome {
  return {
    checks: wholeCount(watch.checks),
    judgeCalls: wholeCount(watch.judgeCalls),
    hints: wholeCount(watch.hints),
    stopped: watch.stopped === true,
    judge: watch.judge === null ? null : outcomeLabel(watch.judge),
  };
}

/** A record's watch, or undefined when it has none (no watch, an older record) or one this reader cannot trust. */
export function readWatchOutcome(row: TaskOutcomeRecord): WatchOutcome | undefined {
  const watch: unknown = (row as { watch?: unknown }).watch;
  if (typeof watch !== "object" || watch === null) return undefined;
  const w = watch as Record<string, unknown>;
  const whole = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;
  if (!whole(w.checks) || !whole(w.judgeCalls) || !whole(w.hints) || typeof w.stopped !== "boolean" ||
    !(w.judge === null || typeof w.judge === "string")) return undefined;
  return { checks: w.checks, judgeCalls: w.judgeCalls, hints: w.hints, stopped: w.stopped, judge: w.judge };
}

// ------------------------------------------------------ quality (issue #40)

/** Criteria facts as counts by state; `base` adds counts already taken. */
export function criteriaOutcome(
  facts: ReadonlyArray<{ state: "passed" | "failed" | "unverified" }>,
  base: CriteriaOutcome = { passed: 0, failed: 0, unverified: 0 },
): CriteriaOutcome {
  const out = { passed: wholeCount(base.passed), failed: wholeCount(base.failed), unverified: wholeCount(base.unverified) };
  for (const f of facts) if (f.state === "passed" || f.state === "failed" || f.state === "unverified") out[f.state] += 1;
  return out;
}

/**
 * A task's game checks summed: games and errors added, the median game
 * time the median of the checks' medians (whole ms). Undefined when no
 * game was played.
 */
export function gamesOutcome(runs: ReadonlyArray<{ n: number; errors: number; medianMs: number }>): GamesOutcome | undefined {
  const played = runs.filter((r) => wholeCount(r.n) > 0);
  if (played.length === 0) return undefined;
  const medians = played.map((r) => wholeCount(r.medianMs)).sort((a, b) => a - b);
  const mid = Math.floor(medians.length / 2);
  const medianMs = medians.length % 2 === 1 ? medians[mid]! : Math.round((medians[mid - 1]! + medians[mid]!) / 2);
  return {
    n: played.reduce((n, r) => n + wholeCount(r.n), 0),
    errors: played.reduce((n, r) => n + wholeCount(r.errors), 0),
    medianMs,
  };
}

/** How many screenshots a task's check results carry (each result's list, or none). */
export function shotsOutcome(lists: ReadonlyArray<readonly unknown[] | undefined>): number {
  return lists.reduce<number>((n, list) => n + (Array.isArray(list) ? list.length : 0), 0);
}

const isWhole = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

/** A record's criteria counts; undefined on an older record or one this reader cannot trust. */
export function readCriteriaOutcome(row: TaskOutcomeRecord): CriteriaOutcome | undefined {
  const c: unknown = (row as { criteria?: unknown }).criteria;
  if (typeof c !== "object" || c === null) return undefined;
  const r = c as Record<string, unknown>;
  return isWhole(r.passed) && isWhole(r.failed) && isWhole(r.unverified)
    ? { passed: r.passed, failed: r.failed, unverified: r.unverified }
    : undefined;
}

/** A record's games; undefined on an older record or one this reader cannot trust. */
export function readGamesOutcome(row: TaskOutcomeRecord): GamesOutcome | undefined {
  const g: unknown = (row as { games?: unknown }).games;
  if (typeof g !== "object" || g === null) return undefined;
  const r = g as Record<string, unknown>;
  return isWhole(r.n) && isWhole(r.errors) && isWhole(r.medianMs) ? { n: r.n, errors: r.errors, medianMs: r.medianMs } : undefined;
}

/** A record's screenshot count; undefined on an older record or a malformed one. */
export function readShotsOutcome(row: TaskOutcomeRecord): number | undefined {
  const s: unknown = (row as { shots?: unknown }).shots;
  return isWhole(s) ? s : undefined;
}

/** USD kept to a millionth of a dollar: sums of floats stay readable in the file. */
export function roundUsd(usd: number): number;
export function roundUsd(usd: number | null): number | null;
export function roundUsd(usd: number | null): number | null {
  return usd === null ? null : Math.round(usd * 1e6) / 1e6;
}

/** A row's cost, or null when nothing could price it. */
export function rowCostUsd(
  row: Pick<WorkerTaskResult, "usage" | "billing">,
  pricing: WorkerPricing | undefined,
): number | null {
  if (row.usage === undefined) return pricing === undefined ? null : 0;
  if (
    pricing === undefined &&
    row.billing === undefined &&
    reportedCostUsd(row.usage) === undefined
  ) {
    return null;
  }
  return taskSpendUsd(row, pricing);
}

/** An id the log may carry: a short identifier, nothing that reads as text or a path. */
export const OUTCOME_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
const safeId = (id: string | undefined): string | undefined =>
  id !== undefined && OUTCOME_ID_PATTERN.test(id) && !id.split("/").includes("..") ? id : undefined;

/** One task's line. Reads only counts, fixed categories and the task's identifiers off the row. */
export function taskOutcomeRecord(
  row: WorkerTaskResult,
  context: TaskOutcomeContext,
  sessionId: string,
  now: Date,
): TaskOutcomeRecord {
  // A review pass re-ran the task with findings, as a judge retry did:
  // `judgeRetried` keeps such a row out of direct check evidence.
  const retried = row.judge?.retried === true || (context.review?.passes ?? 0) > 0;
  return {
    v: OUTCOME_RECORD_VERSION,
    type: "task",
    ts: now.toISOString(),
    session: sessionTag(sessionId),
    ...(safeId(row.id) === undefined ? {} : { taskId: row.id }),
    ...(safeId(context.milestoneId) === undefined ? {} : { milestoneId: context.milestoneId! }),
    provider: outcomeLabel(context.provider),
    model: outcomeLabel(context.model),
    leg: context.leg,
    role: context.role,
    ...(context.taskRole === undefined ? {} : { taskRole: context.taskRole }),
    ...(context.routingIdentity !== undefined && /^[a-f0-9]{64}$/.test(context.routingIdentity) ? { routingIdentity: context.routingIdentity } : {}),
    // Checks ran in the workspace this worker edited: a weakened test still
    // passes. The row cannot tell; see README "Measured routing".
    ...((row.checks?.total ?? 0) > 0 && (row.escalations ?? 0) === 0 && !retried &&
      context.merge !== "held" && context.merge !== "conflict"
      ? (row.checks!.failed > 0 && row.status === "failed"
        ? { acceptance: "checks-failed" as const, acceptanceScope: "task-checks" as const }
        : row.checks!.failed === 0 && row.status === "ok"
          ? { acceptance: "checks-passed" as const, acceptanceScope: "task-checks" as const } : {})
      : {}),
    ...(context.taskChecks === undefined
      ? {}
      : { taskChecks: Math.max(context.taskChecks, row.checks?.total ?? 0) }),
    selfCheckPassed: row.selfCheckPassed === true,
    status: row.status,
    failure: failureCategory(row),
    attempt: Math.max(1, context.attempt),
    judgeRetried: retried,
    ...(context.review === undefined ? {} : { review: context.review }),
    ...(row.watch === undefined ? {} : { watch: watchOutcome(row.watch) }),
    ...(context.criteria === undefined ? {} : { criteria: criteriaOutcome([], context.criteria) }),
    ...(context.games === undefined ? {} : { games: { n: wholeCount(context.games.n), errors: wholeCount(context.games.errors), medianMs: wholeCount(context.games.medianMs) } }),
    ...(context.shots === undefined || wholeCount(context.shots) === 0 ? {} : { shots: wholeCount(context.shots) }),
    selfCheckNotice: row.selfCheckNotice === true,
    escalations: row.escalations ?? 0,
    judge: judgeOutcome(row),
    syntaxDemoted: (row.syntax?.failedFiles.length ?? 0) > 0,
    steps: row.stepCount,
    // Work time (issue #30): the wall time less the wait for the first
    // token and for the operator's approval of the worker's checks. The
    // report's median and measured routing read it; `wallMs` keeps the rest.
    durationMs: Math.max(0, Math.round(row.durationMs - (row.queuedMs ?? 0) - (row.heldMs ?? 0))),
    wallMs: Math.max(0, Math.round(row.durationMs)),
    // A local worker without reported usage: its timing tokens (#30),
    // whose "in" includes each step's cached prompt part. Still unpriced.
    tokensIn: row.usage?.promptTokens ?? row.localTokens?.promptTokens ?? 0,
    tokensOut: row.usage?.completionTokens ?? row.localTokens?.predictedTokens ?? 0,
    cachedTokens: row.usage !== undefined ? (row.usage.cachedTokens ?? null) : (row.localTokens?.cacheHitTokens ?? null),
    costUsd: roundUsd(rowCostUsd(row, context.pricing)),
    merge: context.merge,
  };
}

/** The writer `fusion.delegate` and the runtime append through. */
export interface FusionOutcomeSink {
  append(records: readonly OutcomeRecord[]): void;
}

export interface FusionOutcomeLogOptions {
  /** `<stateDir>/fusion/outcomes.ndjson`. */
  path: string;
  maxBytes?: number;
  keep?: number;
  /** Read per append, so the config toggle takes effect without a restart. */
  enabled?: () => boolean;
  warn?: (message: string, fields: Record<string, unknown>) => void;
}

export function outcomeLogPath(stateDir: string): string {
  return join(stateDir, FUSION_OUTCOMES_DIR_NAME, FUSION_OUTCOMES_FILE_NAME);
}

/** The live file first, then the rotated ones, newest first. */
export function outcomeLogFiles(path: string, keep = OUTCOME_LOG_KEEP): string[] {
  return [path, ...Array.from({ length: keep }, (_, i) => `${path}.${i + 1}`)];
}

/**
 * Appends whole lines, rotating before an append would pass the size
 * bound: `.N` is dropped, each `.i` becomes `.i+1`, the live file `.1`.
 * Synchronous, so lines from concurrent fan-outs never interleave; across
 * processes, rotation happens only under `<log>.lock` (`outcome-log-lock.ts`).
 */
export class FusionOutcomeLog implements FusionOutcomeSink {
  private readonly path: string;
  private readonly maxBytes: number;
  private readonly keep: number;
  private readonly enabled: () => boolean;
  private readonly warn: FusionOutcomeLogOptions["warn"];

  constructor(options: FusionOutcomeLogOptions) {
    this.path = options.path;
    this.maxBytes = options.maxBytes ?? OUTCOME_LOG_MAX_BYTES;
    this.keep = Math.max(0, options.keep ?? OUTCOME_LOG_KEEP);
    this.enabled = options.enabled ?? (() => true);
    this.warn = options.warn;
  }

  append(records: readonly OutcomeRecord[]): void {
    if (records.length === 0) return;
    try {
      if (!this.enabled()) return;
      const text = records.map((r) => `${JSON.stringify(r)}\n`).join("");
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      // Other processes (TUI, sidecar, scheduler) append to the same file:
      // only the lock's holder rotates, checking the size once it holds it.
      // Without the lock in a short wait, the line goes in unrotated.
      let release: (() => void) | undefined;
      try {
        release = tryAcquireOutcomeLock(`${this.path}.lock`);
      } catch {
        release = undefined;
      }
      try {
        if (release !== undefined) this.rotateFor(Buffer.byteLength(text));
        // A crash mid-append leaves a torn last line: start on a fresh one,
        // so only the torn line is lost to a reader.
        appendFileSync(this.path, this.endsTorn() ? `\n${text}` : text, { mode: 0o600 });
      } finally {
        release?.();
      }
    } catch (err) {
      // Never the fan-out's problem: the line is dropped and said once here.
      this.warn?.("fusion: the outcome log could not be written", {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private endsTorn(): boolean {
    let fd: number | undefined;
    try {
      const size = statSync(this.path).size;
      if (size === 0) return false;
      fd = openSync(this.path, "r");
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, size - 1);
      return last[0] !== 0x0a;
    } catch {
      return false;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  private rotateFor(incoming: number): void {
    let size = 0;
    try {
      size = statSync(this.path).size;
    } catch {
      return;
    }
    if (size === 0 || size + incoming <= this.maxBytes) return;
    if (this.keep === 0) {
      rmSync(this.path, { force: true });
      return;
    }
    rmSync(`${this.path}.${this.keep}`, { force: true });
    for (let i = this.keep - 1; i >= 1; i -= 1) {
      try {
        renameSync(`${this.path}.${i}`, `${this.path}.${i + 1}`);
      } catch {
        // A gap in the chain is fine: that file did not exist.
      }
    }
    try {
      renameSync(this.path, `${this.path}.1`);
    } catch {
      // Gone already (a writer outside the lock's rules): the append
      // starts a fresh live file.
    }
  }
}
