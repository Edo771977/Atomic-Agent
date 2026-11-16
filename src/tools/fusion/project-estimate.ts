import {
  DEFAULT_FUSION_PROJECT_FULL_PLAN_ABOVE_TASKS,
  DEFAULT_FUSION_PROJECT_FULL_PLAN_ABOVE_USD,
  type UserFusionProjectConfig,
} from "../../config/llm-run-mode-config.js";
import { estimateSummedUsageCostUsd } from "../../llm/provider/usage-cost.js";
import { MODEL_TIER_ORDER, type ModelTier } from "../../llm/provider/presets/model-tiers.js";
import { parseTeamMember, type TeamMember } from "../../llm/run-mode/fusion-team.js";
import {
  planTotals,
  type AssignmentRow,
  type EstimateBasis,
  type PlanDetail,
  type ProjectPlanTotals,
} from "../../session/session-project.js";
import { outcomeLabel, roundUsd, type OutcomeRecord, type TaskOutcomeRecord } from "./outcome-log.js";
import { taskCheckEvidence } from "./outcome-evidence.js";
import type { WorkerPricing } from "./worker-result.js";

/**
 * Estimates for a fusion project plan (issue #39): what one task on one
 * team member is likely to cost and take, the plan's totals and the
 * limits it breaks, and the cheaper / higher-quality variants the
 * person can ask for at the plan gate. Pure: callers pass the outcome
 * records (`readRoutingHistory`), the member's price
 * (`resolveWorkerPricing`), tiers (`teamStrengthOf`) and the live
 * limits; nothing here reads config, files or the clock.
 *
 * These are descriptive figures from past runs or a fixed per-role
 * token budget, not predictions; the card says which (`basis`,
 * `priceOnly`).
 */

/**
 * Tokens a typical task of each role spends, for a price-only estimate
 * when there is too little history. `null` (no role) counts as `build`.
 * Rough on purpose: an agentic build task re-reads its context every
 * step, so input dominates.
 */
export const PRESET_TASK_TOKENS: Readonly<Record<"plan" | "build" | "review" | "explore" | "utility", { input: number; output: number }>> = {
  plan: { input: 40_000, output: 6_000 },
  build: { input: 150_000, output: 12_000 },
  review: { input: 60_000, output: 4_000 },
  explore: { input: 80_000, output: 4_000 },
  utility: { input: 20_000, output: 2_000 },
};

export const PRESET_REASON = "insufficient data, chosen from the preset";

export interface RowEstimate {
  basis: EstimateBasis;
  /** Exact rows found for member + role (also when too few to measure). */
  samples: number;
  estCostUsd: number | null;
  estMs: number | null;
  /** The cost is price × {@link PRESET_TASK_TOKENS}, not measured spend. */
  priceOnly: boolean;
  reason: string;
}

export interface EstimateRowOptions {
  /** `measuredRouting.minSamples`. */
  minSamples: number;
  /** `measuredRouting.days`. */
  days: number;
  now?: number;
  /** The local leg's measured speed (`localTokensPerSecond`); absent or null for a cloud member. */
  tokensPerSecond?: number | null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

function presetTokens(role: string | null): { input: number; output: number } {
  return PRESET_TASK_TOKENS[(role ?? "build") as keyof typeof PRESET_TASK_TOKENS] ?? PRESET_TASK_TOKENS.build;
}

/**
 * The rows that are exactly this member in this role within the window.
 * A path-like label was cut when written (`outcomeLabel`), so its rows
 * cannot be attributed and none count. A row without `taskRole` (older)
 * is matched by `role`.
 */
function exactRows(
  records: readonly OutcomeRecord[],
  member: TeamMember,
  role: string | null,
  days: number,
  now: number,
): TaskOutcomeRecord[] {
  if (outcomeLabel(member.providerId) !== member.providerId || outcomeLabel(member.model) !== member.model) return [];
  const since = now - days * 86_400_000;
  return records.filter((r): r is TaskOutcomeRecord => {
    if (r.type !== "task" || r.v !== 1 || r.provider !== member.providerId || r.model !== member.model) return false;
    const rowRole = r.taskRole !== undefined ? r.taskRole : r.role;
    if (rowRole !== role) return false;
    const ts = Date.parse(r.ts);
    return Number.isFinite(ts) && ts >= since && ts <= now && finite(r.durationMs) && (r.costUsd === null || finite(r.costUsd));
  });
}

/**
 * One task on `member` in `role`. With at least `minSamples` exact rows:
 * medians of their work time and, only when every row was priced, of
 * their cost (`measured`). Otherwise `preset`: cost is `pricing` × the
 * role's {@link PRESET_TASK_TOKENS} (price-only) or unknown, time comes
 * from the local speed for the output tokens or is unknown.
 */
export function estimateRow(
  member: TeamMember,
  role: string | null,
  records: readonly OutcomeRecord[],
  pricing: WorkerPricing | undefined,
  options: EstimateRowOptions,
): RowEstimate {
  const now = options.now ?? Date.now();
  const rows = exactRows(records, member, role, options.days, now);
  if (rows.length >= Math.max(1, options.minSamples)) {
    const allPriced = rows.every((r) => r.costUsd !== null);
    const cost = allPriced ? median(rows.map((r) => r.costUsd as number)) : null;
    return {
      basis: "measured",
      samples: rows.length,
      estCostUsd: cost === null ? null : roundUsd(cost),
      estMs: median(rows.map((r) => r.durationMs)),
      priceOnly: false,
      reason: `measured: median of ${rows.length} runs`,
    };
  }
  const tokens = presetTokens(role);
  const cost =
    pricing === undefined
      ? null
      : roundUsd(
          estimateSummedUsageCostUsd(
            { promptTokens: tokens.input, completionTokens: tokens.output, totalTokens: tokens.input + tokens.output },
            pricing,
          ),
        );
  const tps = options.tokensPerSecond;
  return {
    basis: "preset",
    samples: rows.length,
    estCostUsd: cost,
    estMs: finite(tps) && tps > 0 ? Math.round((tokens.output / tps) * 1000) : null,
    priceOnly: cost !== null,
    reason: PRESET_REASON,
  };
}

/**
 * Share of this member's checked task rows whose declared checks passed
 * (`taskCheckEvidence`), any role, within the window; null without any.
 * The quality variant's tie-break.
 */
export function acceptanceRate(
  records: readonly OutcomeRecord[],
  member: TeamMember,
  options: { days: number; now?: number },
): number | null {
  const now = options.now ?? Date.now();
  const since = now - options.days * 86_400_000;
  let passed = 0;
  let checked = 0;
  for (const r of records) {
    if (r.type !== "task" || r.provider !== member.providerId || r.model !== member.model) continue;
    const ts = Date.parse(r.ts);
    if (!Number.isFinite(ts) || ts < since || ts > now) continue;
    const evidence = taskCheckEvidence(r);
    if (evidence === "unverified") continue;
    checked += 1;
    if (evidence === "passed") passed += 1;
  }
  return checked === 0 ? null : passed / checked;
}

// ------------------------------------------------------------------ plan

export interface PlanConstraints {
  /** Whether a member ref runs on the local engine (shares its slots). */
  isLocal: (ref: string) => boolean;
  /** `runMode.fusion.turnBudgetUsd`; a milestone runs in one turn, so each must fit. */
  turnBudgetUsd?: number;
  /**
   * What is left of `costTracking.dailyLimitUsd` today; null/absent: no
   * limit. The next milestone must fit (hard); the whole plan only warns,
   * since the limit resets daily and later milestones run on later days.
   */
  dailyRemainingUsd?: number | null;
  /** The milestone that runs next (the daily-limit check); absent: the rows' first. */
  nextMilestoneId?: string;
  /** Local worker slots (`runMode.fusion.workers`); absent: no slot limit. */
  localSlots?: number;
  /** The folder's provider policy (`projects.constraints`); absent: all allowed. */
  allows?: (providerId: string) => boolean;
}

export type PlanViolation =
  | { kind: "turn-budget"; severity: "hard"; milestoneId: string; estimateUsd: number; limitUsd: number }
  | { kind: "daily-limit"; severity: "hard"; scope: "milestone"; milestoneId: string; estimateUsd: number; remainingUsd: number }
  | { kind: "daily-limit"; severity: "warn"; scope: "plan"; estimateUsd: number; remainingUsd: number }
  | { kind: "local-slots"; severity: "warn"; milestoneId: string; localTasks: number; slots: number }
  | { kind: "folder-policy"; severity: "hard"; taskId: string; member: string; as: "worker" | "reviewer" };

export interface MilestoneEstimate {
  id: string;
  /** Known costs summed; null when none is known. */
  costUsd: number | null;
  /** Wave time: cloud tasks in parallel, local tasks packed over the slots; null when none is known. */
  ms: number | null;
}

export interface PlanEstimate {
  /** `costUsd` and `unknownCostRows` as `planTotals`; `ms` is the sum of the milestones' wave times. */
  totals: ProjectPlanTotals;
  /** In first-appearance order of the rows' milestones. */
  milestones: MilestoneEstimate[];
  violations: PlanViolation[];
  /** {@link describeViolation} of each hard one: what `applyProjectDecision` refuses approve on. */
  hardViolations: string[];
}

const usd = (n: number): string => `$${n.toFixed(2)}`;

/** One line for the card and the refusal. */
export function describeViolation(v: PlanViolation): string {
  switch (v.kind) {
    case "turn-budget":
      return `milestone ${v.milestoneId} is estimated at ${usd(v.estimateUsd)}, over the turn budget of ${usd(v.limitUsd)}`;
    case "daily-limit":
      return v.scope === "milestone"
        ? `milestone ${v.milestoneId} is estimated at ${usd(v.estimateUsd)}, over the ${usd(v.remainingUsd)} left of today's limit`
        : `the whole plan is estimated at ${usd(v.estimateUsd)}, over the ${usd(v.remainingUsd)} left of today's limit; later milestones may have to wait for tomorrow`;
    case "local-slots":
      return `milestone ${v.milestoneId} has ${v.localTasks} local tasks for ${v.slots} slots; they run in turns`;
    case "folder-policy":
      return `task ${v.taskId}: this folder's policy does not allow ${v.member} as ${v.as}`;
  }
}

/** Longest-first packing of durations over `slots` lanes: the time the last lane ends. */
function packedMs(durations: number[], slots: number): number {
  if (durations.length === 0) return 0;
  if (!Number.isFinite(slots) || slots >= durations.length) return Math.max(...durations);
  const lanes = new Array<number>(Math.max(1, Math.floor(slots))).fill(0);
  for (const d of [...durations].sort((a, b) => b - a)) {
    let min = 0;
    for (let i = 1; i < lanes.length; i += 1) if (lanes[i]! < lanes[min]!) min = i;
    lanes[min]! += d;
  }
  return Math.max(...lanes);
}

function providerOf(ref: string): string {
  const i = ref.indexOf(":");
  return i < 0 ? ref : ref.slice(0, i);
}

/**
 * Totals and limit checks over the rows (already estimated). Milestones
 * run one after another; inside one, tasks run in parallel, local ones
 * sharing `localSlots`. Times are from the rows that have one.
 */
export function estimatePlan(rows: readonly AssignmentRow[], constraints: PlanConstraints): PlanEstimate {
  const order: string[] = [];
  const byMilestone = new Map<string, AssignmentRow[]>();
  for (const row of rows) {
    if (!byMilestone.has(row.milestoneId)) {
      byMilestone.set(row.milestoneId, []);
      order.push(row.milestoneId);
    }
    byMilestone.get(row.milestoneId)!.push(row);
  }
  const slots = constraints.localSlots ?? Number.POSITIVE_INFINITY;
  const violations: PlanViolation[] = [];
  const milestones: MilestoneEstimate[] = [];
  for (const id of order) {
    const group = byMilestone.get(id)!;
    const local = group.filter((r) => constraints.isLocal(r.worker));
    const cloud = group.filter((r) => !constraints.isLocal(r.worker));
    const known = (list: AssignmentRow[]) => list.flatMap((r) => (r.estMs === null ? [] : [r.estMs]));
    const anyMs = group.some((r) => r.estMs !== null);
    const ms = anyMs ? Math.max(packedMs(known(local), slots), packedMs(known(cloud), Number.POSITIVE_INFINITY)) : null;
    const costUsd = planTotals(group).costUsd;
    milestones.push({ id, costUsd, ms });
    if (constraints.turnBudgetUsd !== undefined && costUsd !== null && costUsd > constraints.turnBudgetUsd) {
      violations.push({ kind: "turn-budget", severity: "hard", milestoneId: id, estimateUsd: costUsd, limitUsd: constraints.turnBudgetUsd });
    }
    if (Number.isFinite(slots) && local.length > slots) {
      violations.push({ kind: "local-slots", severity: "warn", milestoneId: id, localTasks: local.length, slots });
    }
  }
  const sums = planTotals(rows);
  const remaining = constraints.dailyRemainingUsd;
  if (remaining !== undefined && remaining !== null) {
    const nextId = constraints.nextMilestoneId ?? order[0];
    const next = milestones.find((m) => m.id === nextId);
    if (next !== undefined && next.costUsd !== null && next.costUsd > remaining) {
      violations.push({ kind: "daily-limit", severity: "hard", scope: "milestone", milestoneId: next.id, estimateUsd: next.costUsd, remainingUsd: remaining });
    }
    if (sums.costUsd !== null && sums.costUsd > remaining) {
      violations.push({ kind: "daily-limit", severity: "warn", scope: "plan", estimateUsd: sums.costUsd, remainingUsd: remaining });
    }
  }
  if (constraints.allows !== undefined) {
    for (const row of rows) {
      if (!constraints.allows(providerOf(row.worker))) {
        violations.push({ kind: "folder-policy", severity: "hard", taskId: row.taskId, member: row.worker, as: "worker" });
      }
      if (row.reviewer !== null && !constraints.allows(providerOf(row.reviewer))) {
        violations.push({ kind: "folder-policy", severity: "hard", taskId: row.taskId, member: row.reviewer, as: "reviewer" });
      }
    }
  }
  const knownMs = milestones.flatMap((m) => (m.ms === null ? [] : [m.ms]));
  return {
    totals: { ...sums, ms: knownMs.length === 0 ? null : knownMs.reduce((a, b) => a + b, 0) },
    milestones,
    violations,
    hardViolations: violations.filter((v) => v.severity === "hard").map(describeViolation),
  };
}

/**
 * How much of the plan the card shows by default: `full` when `/plan`
 * forces it, or the plan has more tasks than `fullPlanAboveTasks`
 * (default 4) or a known cost above `fullPlanAboveUsd` (default $1);
 * else `compact`. An unknown cost is not "above".
 */
export function planDetailFor(
  plan: { readonly rows: readonly unknown[]; readonly totals: Pick<ProjectPlanTotals, "costUsd"> },
  cfg: UserFusionProjectConfig | undefined,
  forced: boolean,
): PlanDetail {
  if (forced) return "full";
  const tasks = cfg?.fullPlanAboveTasks ?? DEFAULT_FUSION_PROJECT_FULL_PLAN_ABOVE_TASKS;
  const usdCap = cfg?.fullPlanAboveUsd ?? DEFAULT_FUSION_PROJECT_FULL_PLAN_ABOVE_USD;
  if (plan.rows.length > tasks) return "full";
  const cost = plan.totals.costUsd;
  return cost !== null && cost > usdCap ? "full" : "compact";
}

// -------------------------------------------------------------- variants

export interface VariantContext {
  /** The members a task may be given: team workers the folder's policy allows and that can answer, in config order. */
  members: readonly TeamMember[];
  /** The member's tier (`teamStrengthOf`); null when it holds none. */
  strength: (member: TeamMember) => ModelTier | null;
  isLocal: (member: TeamMember) => boolean;
  /** {@link estimateRow} for the row's role, bound by the caller. */
  estimate: (member: TeamMember, row: AssignmentRow) => RowEstimate;
  /** {@link acceptanceRate}; absent: ties keep config order. */
  acceptance?: (member: TeamMember) => number | null;
  /** The reviewer of a task the member works (`FusionTeamRouting.reviewerFor`); absent: the row's reviewer is kept unless it is the new worker. */
  reviewerFor?: (worker: TeamMember) => TeamMember | null;
}

/** Local below any cloud member; a cloud member by tier; null: a cloud member without a tier. */
function rank(member: TeamMember, ctx: VariantContext): number | null {
  if (ctx.isLocal(member)) return 0;
  const tier = ctx.strength(member);
  return tier === null ? null : MODEL_TIER_ORDER.indexOf(tier) + 1;
}

/**
 * `candidate` is not weaker than `current`: the same member; any cloud
 * member over a local one; else both tiers known and the candidate's at
 * least as high. Unknown tiers are not compared, so never chosen.
 */
function notWeaker(candidate: TeamMember, current: TeamMember, ctx: VariantContext): boolean {
  if (candidate.ref === current.ref) return true;
  if (ctx.isLocal(current)) return !ctx.isLocal(candidate);
  const c = rank(candidate, ctx);
  const w = rank(current, ctx);
  return c !== null && w !== null && c >= w;
}

function reassign(row: AssignmentRow, worker: TeamMember, est: RowEstimate, why: string, ctx: VariantContext): AssignmentRow {
  const reviewer =
    ctx.reviewerFor !== undefined
      ? (ctx.reviewerFor(worker)?.ref ?? null)
      : row.reviewer === worker.ref
        ? null
        : row.reviewer;
  return {
    ...row,
    worker: worker.ref,
    reviewer,
    reason: `${why} (${est.reason})`,
    basis: est.basis,
    samples: est.samples,
    estCostUsd: est.estCostUsd,
    estMs: est.estMs,
  };
}

/**
 * Per row, the member with the lowest known cost among those not weaker
 * than the current worker; a row nothing beats keeps its worker and
 * estimate unchanged.
 */
export function cheaperVariant(rows: readonly AssignmentRow[], ctx: VariantContext): AssignmentRow[] {
  return rows.map((row) => {
    const current = parseTeamMember(row.worker);
    if (current === null) return row;
    let best: { member: TeamMember; est: RowEstimate } | null = null;
    let bestCost = row.estCostUsd ?? Number.POSITIVE_INFINITY;
    for (const member of ctx.members) {
      if (member.ref === current.ref || !notWeaker(member, current, ctx)) continue;
      const est = ctx.estimate(member, row);
      if (est.estCostUsd !== null && est.estCostUsd < bestCost) {
        best = { member, est };
        bestCost = est.estCostUsd;
      }
    }
    return best === null ? row : reassign(row, best.member, best.est, "cheapest known cost not weaker than the planned worker", ctx);
  });
}

/**
 * Per row, the member of the highest tier (local lowest, a cloud member
 * without a tier with the cheapest); a tie goes to the better
 * acceptance rate, then config order. A row already on that member is
 * kept unchanged.
 */
export function qualityVariant(rows: readonly AssignmentRow[], ctx: VariantContext): AssignmentRow[] {
  const score = (m: TeamMember): number => rank(m, ctx) ?? 1;
  let top: TeamMember | null = null;
  for (const member of ctx.members) {
    if (top === null) {
      top = member;
      continue;
    }
    const diff = score(member) - score(top);
    if (diff > 0) top = member;
    else if (diff === 0 && (ctx.acceptance?.(member) ?? -1) > (ctx.acceptance?.(top) ?? -1)) top = member;
  }
  if (top === null) return [...rows];
  const chosen = top;
  return rows.map((row) =>
    row.worker === chosen.ref ? row : reassign(row, chosen, ctx.estimate(chosen, row), "highest tier on the team", ctx),
  );
}
