import { readFileSync } from "node:fs";

import {
  outcomeLogFiles,
  readCriteriaOutcome,
  readGamesOutcome,
  readReviewOutcome,
  readShotsOutcome,
  readWatchOutcome,
  type FailureCategory,
  type OutcomeLeg,
  type OutcomeRecord,
  type TaskOutcomeRecord,
  type TurnOutcomeRecord,
} from "./outcome-log.js";
import {
  formatDurationShort,
  formatTokenCount,
  formatUsdShort,
} from "./turn-receipt.js";
import { taskCheckColumn } from "./outcome-evidence.js";
import { candidateOutcomeEvidence, candidateWorkerRuns, hasCandidateOutcome } from "./candidate-outcomes.js";
import type { CandidateRejectionReason } from "./candidate-acceptance.js";

/**
 * `atomic-agent fusion report` (and `/fusion report` in the TUI): the
 * outcome log (`outcome-log.ts`) aggregated per worker model, plus the
 * orchestrator's own side per provider. Pure over the records; reading
 * the files is `readOutcomeRecords`.
 */

export interface ReportOptions {
  /** Only records from the last N days; absent: everything kept. */
  days?: number;
  /** Case-insensitive substring of a task's model or provider id. */
  model?: string;
  now?: Date;
}

export interface ModelStats {
  provider: string;
  model: string;
  leg: OutcomeLeg;
  tasks: number;
  /** Reported status ok on the first attempt, with no judge retry or self-check notice. */
  firstPassGreen: number;
  firstPassGreenRate: number;
  green: number;
  greenRate: number;
  /** Green after a replan attempt or a judge retry. */
  greenAfterRetry: number;
  /** Consistent acceptance records for declared task checks, including replan attempts. */
  checksPassed: number;
  checksFailed: number;
  /** Missing, legacy, or contradictory task-check evidence; never inferred from status ok. */
  checksUnverified: number;
  /** Rows whose record says no task-attributed check was declared (issue #30). */
  checksNone: number;
  /** Telemetry only: the worker's own last run of a declared check passed after its last change. */
  selfChecked: number;
  /** Aggregated task runs under their configured leg, not physical provider requests or quality samples. */
  candidate: CandidateTaskRunStats;
  /** Per-task review's last decision (issue #38); `notReviewed`: no review field, an older record or review off. */
  review: ReviewStats;
  /** The watch on running tasks (issue #43); `watched`: records with a watch field. */
  watch: WatchStats;
  /** Success criteria over the records that carry them (issue #40); `recorded`: such records. */
  criteria: CriteriaStats;
  /** Played games (issue #40); `medianMs`: median of the records' medians, null with none. */
  games: GamesStats;
  /** Screenshots stored by the tasks' checks (issue #40). */
  shots: number;
  topFailures: Array<{ category: FailureCategory; count: number }>;
  escalated: number;
  escalationRate: number;
  selfCheckNotices: number;
  /** Of those, the tasks that came back green. */
  selfCheckFixed: number;
  selfCheckFixRate: number | null;
  syntaxDemoted: number;
  medianDurationMs: number;
  tokensIn: number;
  tokensOut: number;
  /** Null when no task of this model was priced. */
  costUsd: number | null;
  /** Tasks with no price, left out of `costUsd` (shown as "(+N unpriced)", issue #74). */
  unpricedTasks: number;
}

export interface CriteriaStats {
  recorded: number;
  passed: number;
  failed: number;
  unverified: number;
}

export interface GamesStats {
  recorded: number;
  n: number;
  errors: number;
  medianMs: number | null;
}

export interface WatchStats {
  watched: number;
  judgeCalls: number;
  hints: number;
  stopped: number;
}

export interface ReviewStats {
  reviewed: number;
  accept: number;
  needsChanges: number;
  unverified: number;
  notReviewed: number;
  /** Median extra worker passes over the reviewed tasks; null when none was reviewed. */
  medianPasses: number | null;
}

/** One reviewer model's reviews, over every task it reviewed. */
export interface ReviewerStats {
  /** The reviewer's `outcomeLabel`, or `REVIEW_WITHOUT_MODEL` when no model reviewed. */
  reviewer: string;
  reviews: number;
  accept: number;
  needsChanges: number;
  unverified: number;
  medianPasses: number;
  blockers: number;
  majors: number;
  minors: number;
}

/** The reviewer table's row for reviews no model gave (a red fact decided, or no reviewer was reached). */
export const REVIEW_WITHOUT_MODEL = "(automated checks only)";

export interface CandidateTaskRunStats {
  taskRuns: number;
  /** Sum of explicitly counted worker task invocations; not per-provider inference requests. */
  knownWorkerRuns: number;
  /** Task runs whose worker invocation count is absent or invalid. */
  workerRunsUnverified: number;
  promoted: number;
  rejected: number;
  unchanged: number;
  unverified: number;
  taskChecksPassed: number;
  taskChecksFailed: number;
  taskChecksUnverified: number;
  rejectionReasons: Array<{ reason: CandidateRejectionReason; count: number }>;
}

export interface OrchestratorStats {
  provider: string;
  models: string[];
  turns: number;
  requests: number;
  tokensIn: number;
  tokensOut: number;
  /** Cached share of the prompt tokens of the turns that reported one. */
  cacheHitPct: number | null;
  /** Mean per-step cache hit over the steps that reported one. */
  avgStepCacheHitPct: number | null;
  costUsd: number | null;
  unpricedTurns: number;
}

export interface FusionReport {
  since: string | null;
  tasks: number;
  turns: number;
  workers: ModelStats[];
  orchestratorTargets: ModelStats[];
  orchestrator: OrchestratorStats[];
  /** Per reviewer model, most reviews first; empty when no record has a review. */
  reviewers: ReviewerStats[];
  /** Priced strong-side spend: orchestrator turns plus orchestrator-target tasks. */
  strongSpendUsd: number | null;
  /** Some strong-side requests or orchestrator-target tasks were unpriced. */
  strongSpendPartial: boolean;
}

function isRecord(value: unknown): value is OutcomeRecord {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  const ts = (value as { ts?: unknown }).ts;
  return (type === "task" || type === "turn") && typeof ts === "string";
}

/** Parses NDJSON text, skipping lines that are not outcome records. */
function* outcomeLines(text: string): Generator<OutcomeRecord> {
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) yield parsed;
    } catch {
      // A torn last line (a crash mid-append) is skipped.
    }
  }
}

export function parseOutcomeLines(text: string): OutcomeRecord[] {
  return Array.from(outcomeLines(text));
}

/** The live file and its rotated ones, oldest first. Missing files read as empty. */
export function readOutcomeRecords(
  path: string,
  read: (file: string) => string = (file) => readFileSync(file, "utf8"),
  options: { maxRecords?: number; accept?: (record: OutcomeRecord) => boolean } = {},
): OutcomeRecord[] {
  const records: OutcomeRecord[] = [];
  const maxRecords = options.maxRecords === undefined ? Infinity : Math.max(0, Math.floor(options.maxRecords));
  if (maxRecords === 0) return records;
  let next = 0;
  for (const file of outcomeLogFiles(path).reverse()) {
    let text: string;
    try {
      text = read(file);
    } catch {
      continue;
    }
    for (const record of outcomeLines(text)) {
      if (options.accept?.(record) === false) continue;
      if (records.length < maxRecords) records.push(record);
      else { records[next] = record; next = (next + 1) % maxRecords; }
    }
  }
  return next === 0 ? records : records.slice(next).concat(records.slice(0, next));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

const rate = (n: number, of: number): number => (of === 0 ? 0 : n / of);

/** A median that keeps a half (pass counts are small integers). */
function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function watchStats(rows: readonly TaskOutcomeRecord[]): WatchStats {
  const watches = rows.flatMap((r) => {
    const watch = readWatchOutcome(r);
    return watch === undefined ? [] : [watch];
  });
  return {
    watched: watches.length,
    judgeCalls: watches.reduce((n, w) => n + w.judgeCalls, 0),
    hints: watches.reduce((n, w) => n + w.hints, 0),
    stopped: watches.filter((w) => w.stopped).length,
  };
}

function criteriaStats(rows: readonly TaskOutcomeRecord[]): CriteriaStats {
  const read = rows.flatMap((r) => readCriteriaOutcome(r) ?? []);
  return {
    recorded: read.length,
    passed: read.reduce((n, c) => n + c.passed, 0),
    failed: read.reduce((n, c) => n + c.failed, 0),
    unverified: read.reduce((n, c) => n + c.unverified, 0),
  };
}

function gamesStats(rows: readonly TaskOutcomeRecord[]): GamesStats {
  const read = rows.flatMap((r) => readGamesOutcome(r) ?? []);
  return {
    recorded: read.length,
    n: read.reduce((n, g) => n + g.n, 0),
    errors: read.reduce((n, g) => n + g.errors, 0),
    medianMs: read.length === 0 ? null : median(read.map((g) => g.medianMs)),
  };
}

function reviewStats(rows: TaskOutcomeRecord[]): ReviewStats {
  const reviews = rows.flatMap((r) => {
    const review = readReviewOutcome(r);
    return review === undefined ? [] : [review];
  });
  return {
    reviewed: reviews.length,
    accept: reviews.filter((r) => r.decision === "accept").length,
    needsChanges: reviews.filter((r) => r.decision === "needs-changes").length,
    unverified: reviews.filter((r) => r.decision === "unverified").length,
    notReviewed: rows.length - reviews.length,
    medianPasses: medianOf(reviews.map((r) => r.passes)),
  };
}

function reviewerStats(rows: readonly TaskOutcomeRecord[]): ReviewerStats[] {
  const byReviewer = new Map<string, NonNullable<ReturnType<typeof readReviewOutcome>>[]>();
  for (const row of rows) {
    const review = readReviewOutcome(row);
    if (review === undefined) continue;
    const key = review.reviewer ?? REVIEW_WITHOUT_MODEL;
    const list = byReviewer.get(key);
    if (list === undefined) byReviewer.set(key, [review]);
    else list.push(review);
  }
  return [...byReviewer].map(([reviewer, reviews]) => ({
    reviewer,
    reviews: reviews.length,
    accept: reviews.filter((r) => r.decision === "accept").length,
    needsChanges: reviews.filter((r) => r.decision === "needs-changes").length,
    unverified: reviews.filter((r) => r.decision === "unverified").length,
    medianPasses: medianOf(reviews.map((r) => r.passes)) ?? 0,
    blockers: reviews.reduce((n, r) => n + r.blockers, 0),
    majors: reviews.reduce((n, r) => n + r.majors, 0),
    minors: reviews.reduce((n, r) => n + r.minors, 0),
  })).sort((a, b) => b.reviews - a.reviews || a.reviewer.localeCompare(b.reviewer));
}

function candidateStats(rows: TaskOutcomeRecord[]): CandidateTaskRunStats {
  const stats: CandidateTaskRunStats = { taskRuns: 0, knownWorkerRuns: 0, workerRunsUnverified: 0, promoted: 0, rejected: 0, unchanged: 0, unverified: 0,
    taskChecksPassed: 0, taskChecksFailed: 0, taskChecksUnverified: 0, rejectionReasons: [] };
  const reasons = new Map<CandidateRejectionReason, number>();
  for (const row of rows) {
    if (!hasCandidateOutcome(row)) continue;
    stats.taskRuns += 1;
    const workerRuns = candidateWorkerRuns(row);
    if (workerRuns === undefined) stats.workerRunsUnverified += 1;
    else stats.knownWorkerRuns += workerRuns;
    const evidence = candidateOutcomeEvidence(row);
    if (evidence?.receipt === undefined) { stats.unverified += 1; stats.taskChecksUnverified += 1; continue; }
    stats[evidence.receipt.disposition] += 1;
    if (evidence.receipt.reason !== undefined) reasons.set(evidence.receipt.reason, (reasons.get(evidence.receipt.reason) ?? 0) + 1);
    const checked = evidence.taskChecks;
    if (checked.failed > 0) stats.taskChecksFailed += 1;
    else if (checked.total > 0 && checked.passed === checked.total) stats.taskChecksPassed += 1;
    else stats.taskChecksUnverified += 1;
  }
  stats.rejectionReasons = [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
  return stats;
}

function modelStats(rows: TaskOutcomeRecord[]): ModelStats {
  const first = rows[0]!;
  const green = rows.filter((r) => r.status === "ok");
  const firstPass = green.filter(
    (r) => r.attempt <= 1 && !r.judgeRetried && !r.selfCheckNotice,
  );
  const failures = new Map<FailureCategory, number>();
  for (const r of rows) {
    if (typeof r.failure === "string") failures.set(r.failure, (failures.get(r.failure) ?? 0) + 1);
  }
  const noticed = rows.filter((r) => r.selfCheckNotice);
  const fixed = noticed.filter((r) => r.status === "ok");
  const priced = rows.filter((r) => r.costUsd !== null);
  const escalated = rows.filter((r) => r.escalations > 0).length;
  const checks = rows.map(taskCheckColumn);
  return {
    provider: first.provider,
    model: first.model,
    leg: first.leg,
    tasks: rows.length,
    firstPassGreen: firstPass.length,
    firstPassGreenRate: rate(firstPass.length, rows.length),
    green: green.length,
    greenRate: rate(green.length, rows.length),
    greenAfterRetry: green.filter((r) => r.attempt > 1 || r.judgeRetried).length,
    checksPassed: checks.filter((value) => value === "passed").length,
    checksFailed: checks.filter((value) => value === "failed").length,
    checksUnverified: checks.filter((value) => value === "unverified").length,
    checksNone: checks.filter((value) => value === "no-checks").length,
    selfChecked: rows.filter((r) => r.selfCheckPassed === true).length,
    candidate: candidateStats(rows),
    review: reviewStats(rows),
    watch: watchStats(rows),
    criteria: criteriaStats(rows),
    games: gamesStats(rows),
    shots: rows.reduce((n, r) => n + (readShotsOutcome(r) ?? 0), 0),
    topFailures: [...failures.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([category, count]) => ({ category, count })),
    escalated,
    escalationRate: rate(escalated, rows.length),
    selfCheckNotices: noticed.length,
    selfCheckFixed: fixed.length,
    selfCheckFixRate: noticed.length === 0 ? null : rate(fixed.length, noticed.length),
    syntaxDemoted: rows.filter((r) => r.syntaxDemoted).length,
    medianDurationMs: median(rows.map((r) => r.durationMs)),
    tokensIn: rows.reduce((n, r) => n + r.tokensIn, 0),
    tokensOut: rows.reduce((n, r) => n + r.tokensOut, 0),
    costUsd: priced.length === 0 ? null : priced.reduce((n, r) => n + (r.costUsd ?? 0), 0),
    unpricedTasks: rows.length - priced.length,
  };
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = groups.get(k);
    if (list === undefined) groups.set(k, [row]);
    else list.push(row);
  }
  return [...groups.values()];
}

function orchestratorStats(turns: TurnOutcomeRecord[]): OrchestratorStats {
  const reported = turns.filter((t) => t.orchestrator.cachedTokens !== null);
  const reportedIn = reported.reduce((n, t) => n + t.orchestrator.tokensIn, 0);
  const reportedCached = reported.reduce((n, t) => n + (t.orchestrator.cachedTokens ?? 0), 0);
  const stepRates = turns.flatMap((t) =>
    t.orchestrator.steps.flatMap((s) =>
      s.cached === null || s.in <= 0 ? [] : [Math.min(s.cached, s.in) / s.in],
    ),
  );
  const priced = turns.filter((t) => t.orchestrator.costUsd !== null);
  // A turn whose requests were unpriced is unpriced, even when its judge
  // or escalation calls were priced.
  const unpriced = turns.filter((t) => {
    // A record without the split field: its total is all it has.
    const requests = (t.orchestrator as { requestCostUsd?: number | null }).requestCostUsd;
    return (
      t.orchestrator.requests > 0 &&
      (requests === undefined ? t.orchestrator.costUsd : requests) === null
    );
  });
  return {
    provider: turns[0]!.orchestrator.provider,
    models: [...new Set(turns.map((t) => t.orchestrator.model))],
    turns: turns.length,
    requests: turns.reduce((n, t) => n + t.orchestrator.requests, 0),
    tokensIn: turns.reduce((n, t) => n + t.orchestrator.tokensIn, 0),
    tokensOut: turns.reduce((n, t) => n + t.orchestrator.tokensOut, 0),
    cacheHitPct:
      reportedIn === 0 ? null : Math.round((Math.min(reportedCached, reportedIn) / reportedIn) * 100),
    avgStepCacheHitPct:
      stepRates.length === 0
        ? null
        : Math.round((stepRates.reduce((a, b) => a + b, 0) / stepRates.length) * 100),
    costUsd:
      priced.length === 0 ? null : priced.reduce((n, t) => n + (t.orchestrator.costUsd ?? 0), 0),
    unpricedTurns: unpriced.length,
  };
}

const byTasks = (a: ModelStats, b: ModelStats): number =>
  b.tasks - a.tasks || a.model.localeCompare(b.model);

export function aggregateOutcomes(
  records: readonly OutcomeRecord[],
  options: ReportOptions = {},
): FusionReport {
  const now = options.now ?? new Date();
  const sinceMs =
    options.days === undefined ? undefined : now.getTime() - options.days * 86_400_000;
  const inWindow = records.filter((r) => {
    if (sinceMs === undefined) return true;
    const t = Date.parse(r.ts);
    return Number.isFinite(t) && t >= sinceMs;
  });
  const needle = options.model?.toLowerCase();
  const matches = (model: string, provider: string): boolean =>
    needle === undefined ||
    model.toLowerCase().includes(needle) ||
    provider.toLowerCase().includes(needle);
  const tasks = inWindow.filter(
    (r): r is TaskOutcomeRecord => r.type === "task" && matches(r.model, r.provider),
  );
  const turns = inWindow.filter(
    (r): r is TurnOutcomeRecord =>
      r.type === "turn" && matches(r.orchestrator.model, r.orchestrator.provider),
  );
  const key = (r: TaskOutcomeRecord): string => `${r.provider}\u0000${r.model}\u0000${r.leg}`;
  const workers = groupBy(tasks.filter((r) => r.leg !== "orchestrator"), key)
    .map(modelStats)
    .sort(byTasks);
  const orchestratorTargets = groupBy(tasks.filter((r) => r.leg === "orchestrator"), key)
    .map(modelStats)
    .sort(byTasks);
  const orchestrator = groupBy(turns, (t) => t.orchestrator.provider)
    .map(orchestratorStats)
    .sort((a, b) => b.turns - a.turns || a.provider.localeCompare(b.provider));
  const strongParts = [
    ...orchestrator.map((o) => o.costUsd),
    ...orchestratorTargets.map((o) => o.costUsd),
  ].filter((n): n is number => n !== null);
  return {
    since: sinceMs === undefined ? null : new Date(sinceMs).toISOString(),
    tasks: tasks.length,
    turns: turns.length,
    workers,
    orchestratorTargets,
    orchestrator,
    reviewers: reviewerStats(tasks),
    strongSpendUsd: strongParts.length === 0 ? null : strongParts.reduce((a, b) => a + b, 0),
    strongSpendPartial:
      orchestrator.some((o) => o.unpricedTurns > 0) ||
      tasks.some((r) => r.leg === "orchestrator" && r.costUsd === null),
  };
}

/** `report`'s flags (`--days N`, `--model X`, `--json`); a string is a usage error. */
export function parseReportArgs(
  args: readonly string[],
): (ReportOptions & { json: boolean }) | string {
  const out: ReportOptions & { json: boolean } = { json: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--json") {
      out.json = true;
    } else if (arg === "--days") {
      const value = Number(args[i + 1]);
      if (!Number.isFinite(value) || value <= 0) return "--days needs a positive number";
      out.days = value;
      i += 1;
    } else if (arg === "--model") {
      const value = args[i + 1];
      if (value === undefined || value.length === 0 || value.startsWith("--")) {
        return "--model needs a model or provider name";
      }
      out.model = value;
      i += 1;
    } else {
      return `unknown option: ${arg}`;
    }
  }
  return out;
}

/** The report for the log at `path`, as text or JSON: what the CLI and `/fusion report` print. */
export function renderOutcomeReport(
  path: string,
  options: ReportOptions & { json?: boolean },
  read?: (file: string) => string,
): string {
  const report = aggregateOutcomes(readOutcomeRecords(path, read), options);
  return options.json === true
    ? `${JSON.stringify(report, null, 2)}\n`
    : formatFusionReport(report, options);
}

const pct = (r: number): string => `${Math.round(r * 100)}%`;

function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  return [line(header), ...rows.map(line)];
}

function modelRows(stats: ModelStats[]): string[] {
  return table(
    ["model", "leg", "tasks", "reported 1st-pass", "reported green", "after retry", "checks pass/fail/unverified/no-checks", "criteria pass/fail/unverified", "reviewed accept/needs-changes/unverified", "review passes", "watch hints/stops", "self-checked", "escalated", "self-check fixed", "median", "tokens in/out", "spend", "top failures"],
    stats.map((s) => [
      s.model === s.provider ? s.model : `${s.model} (${s.provider})`,
      s.leg,
      String(s.tasks),
      pct(s.firstPassGreenRate),
      pct(s.greenRate),
      String(s.greenAfterRetry),
      `${s.checksPassed}/${s.checksFailed}/${s.checksUnverified}/${s.checksNone}`,
      s.criteria.recorded === 0 ? "-" : `${s.criteria.passed}/${s.criteria.failed}/${s.criteria.unverified}`,
      s.review.reviewed === 0 ? "-" : `${s.review.accept}/${s.review.needsChanges}/${s.review.unverified}`,
      s.review.medianPasses === null ? "-" : String(s.review.medianPasses),
      s.watch.watched === 0 ? "-" : `${s.watch.hints}/${s.watch.stopped}`,
      String(s.selfChecked),
      pct(s.escalationRate),
      s.selfCheckFixRate === null ? "-" : `${s.selfCheckFixed}/${s.selfCheckNotices}`,
      formatDurationShort(s.medianDurationMs),
      `${formatTokenCount(s.tokensIn)}/${formatTokenCount(s.tokensOut)}`,
      s.costUsd === null
        ? "unpriced"
        : `${formatUsdShort(s.costUsd)}${s.unpricedTasks > 0 ? ` (+${s.unpricedTasks} unpriced)` : ""}`,
      s.topFailures.length === 0
        ? "-"
        : s.topFailures.map((f) => `${f.category} ${f.count}`).join(", "),
    ]),
  );
}

function candidateRows(stats: ModelStats[]): string[] {
  return table(["configured model", "configured leg", "task runs", "known worker runs", "unknown run counts", "promoted", "rejected", "unchanged", "unverified", "final own checks pass/fail/unverified", "rejection reasons"],
    stats.map(s => [s.model === s.provider ? s.model : `${s.model} (${s.provider})`, s.leg, String(s.candidate.taskRuns), String(s.candidate.knownWorkerRuns), String(s.candidate.workerRunsUnverified),
      String(s.candidate.promoted), String(s.candidate.rejected), String(s.candidate.unchanged), String(s.candidate.unverified),
      `${s.candidate.taskChecksPassed}/${s.candidate.taskChecksFailed}/${s.candidate.taskChecksUnverified}`,
      s.candidate.rejectionReasons.length === 0 ? "-" : s.candidate.rejectionReasons.map(r => `${r.reason} ${r.count}`).join(", ")]));
}

export function formatFusionReport(report: FusionReport, options: ReportOptions = {}): string {
  const window = options.days === undefined ? "all kept history" : `last ${options.days} day${options.days === 1 ? "" : "s"}`;
  const filter = options.model === undefined ? "" : `, model matching "${options.model}"`;
  const lines = [`Fusion outcomes, ${window}${filter}: ${report.tasks} task${report.tasks === 1 ? "" : "s"}, ${report.turns} turn${report.turns === 1 ? "" : "s"}`];
  if (report.tasks === 0 && report.turns === 0) {
    lines.push("", "Nothing recorded yet. Fusion turns write their outcomes once a fan-out finishes.");
    return `${lines.join("\n")}\n`;
  }
  if (report.workers.length > 0) {
    lines.push("", "Worker models", ...modelRows(report.workers));
  }
  if (report.orchestratorTargets.length > 0) {
    lines.push("", "Tasks sent to the orchestrator's model", ...modelRows(report.orchestratorTargets));
  }
  const played = [...report.workers, ...report.orchestratorTargets].filter((s) => s.games.recorded > 0);
  if (played.length > 0) {
    lines.push("", ...played.map((s) =>
      `Games: ${s.model === s.provider ? s.model : `${s.model} (${s.provider})`} ${s.games.n} game${s.games.n === 1 ? "" : "s"}, errors ${s.games.errors}, median ${formatDurationShort(s.games.medianMs ?? 0)}`));
  }
  const candidates = [...report.workers, ...report.orchestratorTargets].filter(s => s.candidate.taskRuns > 0);
  if (candidates.length > 0) lines.push("", "Candidate task runs (telemetry only)", ...candidateRows(candidates));
  if (report.reviewers.length > 0) {
    lines.push("", "Reviewer models", ...table(
      ["reviewer", "reviews", "accept/needs-changes/unverified", "median passes", "issues blocker/major/minor"],
      report.reviewers.map((r) => [r.reviewer, String(r.reviews), `${r.accept}/${r.needsChanges}/${r.unverified}`,
        String(r.medianPasses), `${r.blockers}/${r.majors}/${r.minors}`]),
    ));
  }
  if (report.orchestrator.length > 0) {
    lines.push(
      "",
      "Orchestrator",
      ...table(
        ["provider", "turns", "requests", "tokens in/out", "cache hit", "avg step hit", "spend"],
        report.orchestrator.map((o) => [
          o.provider,
          String(o.turns),
          String(o.requests),
          `${formatTokenCount(o.tokensIn)}/${formatTokenCount(o.tokensOut)}`,
          o.cacheHitPct === null ? "not reported" : `${o.cacheHitPct}%`,
          o.avgStepCacheHitPct === null ? "-" : `${o.avgStepCacheHitPct}%`,
          o.costUsd === null
            ? "unpriced"
            : `${formatUsdShort(o.costUsd)}${o.unpricedTurns > 0 ? ` (+${o.unpricedTurns} unpriced)` : ""}`,
        ]),
      ),
    );
  }
  lines.push(
    "",
    `Strong-side spend: ${
      report.strongSpendUsd === null
        ? "unpriced (subscription or no price known)"
        : `${formatUsdShort(report.strongSpendUsd)}${report.strongSpendPartial ? " + unpriced (subscription or no price known)" : ""}`
    }`,
    "Reported green: status ok; reported 1st-pass: status ok on the first attempt with no judge retry, review pass or self-check notice. after retry: reported green after a replan, judge retry or review pass.",
    "Tokens on a local leg whose server reports no usage are its timing counts: \"in\" includes the cached part of each step's prompt.",
    "Checks pass/fail/unverified/no-checks: consistent task-checks acceptance records; missing or contradictory evidence (a judge that could not decide, a held or conflicted merge, a candidate run, an escalation, a judge retry or a review pass, a declared check that never ran, an older record) is unverified; no-checks: no check was attributed to the task. Self-checked (telemetry, never acceptance): the worker's own last verify.run was a declared check of its task and passed after its last change. Replan attempts can have check evidence. The worker can modify the declared checks and their inputs; passing them does not establish semantic correctness or full integration acceptance.",
    "Criteria pass/fail/unverified: the project's success criteria named by a task's checks, after its checks and the vision judgement (unverified: no check result or no vision judgement for a visual one); - : none recorded (no criterion named, or an older record). Games: the game checks' played games, those with errors, and the median of their median game time.",
    "Reviewed accept/needs-changes/unverified: the per-task reviewer's last decision (unverified: no valid verdict); review passes: the median of extra worker passes the review caused, reviewed tasks only; - : no review recorded (review off, or an older record). A review is a model's opinion after the automated checks, not acceptance evidence. Reviewer models: per reviewer, its decisions, median passes and the issues of its last verdicts by severity; (automated checks only): no model reviewed.",
    "Candidate task runs count aggregated task rows by final disposition, not candidate calls or individual worker invocations. Known worker runs count explicit task invocations, including judge retries; missing or invalid counts stay unknown. Invocation counts remain independent of disposition and check validity. Rows are grouped under the configured leg even when retries or escalations used other providers; cost, usage and duration remain row-reported metrics, not complete billing or physical provider performance. Final own checks count only task-attributed final reruns; call-level integration green gives no individual model credit. Candidate rows are telemetry only: promoted-only rates are conditioned on success and never train measured routing quality. Missing or malformed candidate metadata stays unverified.",
  );
  return `${lines.join("\n")}\n`;
}
