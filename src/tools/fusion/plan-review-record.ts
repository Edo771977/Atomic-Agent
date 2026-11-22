import { createHash } from "node:crypto";

import type { AssignmentRow, ProjectReviewBlock } from "../../session/session-project.js";
import type { PlanCheckResult } from "./plan-checks.js";

/**
 * The plan reviewer's record (issue #118): what a model said about a
 * drafted plan, per dimension, before the plan gate reached the person.
 * Runtime-owned, like the references record (issue #120): `project.plan`
 * sets it on the plan update, the state dir's record keeps it, and
 * `project.json` never does (one written there is dropped on read). Pure.
 *
 * A result has the shape of a deterministic plan check
 * (`plan-checks.ts`), so surfaces render both the same way. A `fail`
 * here blocks a plain approval like a review block, but the person may
 * approve over it with a note (`approveOverReview`); a deterministic
 * plan-check failure stays hard.
 */

/** In the order the reviewer is asked and the gate lists them. */
export const PLAN_REVIEW_DIMENSIONS = [
  "criteria-coverage",
  "task-completeness",
  "dependencies",
  "size",
  "verifiability",
  "scope",
  "numbers",
  "decisions",
] as const;
export type PlanReviewDimension = (typeof PLAN_REVIEW_DIMENSIONS)[number];

export interface PlanReviewResult {
  dimension: PlanReviewDimension;
  verdict: "pass" | "warn" | "fail";
  detail: string;
  taskIds: string[];
}

/**
 * `reviewed`: a reviewer answered in the schema. `skipped`: no reviewer
 * could be used (the folder's policy allows none, none can answer);
 * nothing was sent. `not-run`: the call failed or the answer could not
 * be read: never a pass.
 */
export type PlanReviewOutcome = "reviewed" | "skipped" | "not-run";

export interface PlanReviewRecord {
  outcome: PlanReviewOutcome;
  /** The member ref that reviewed (or was asked); null when none was picked. */
  reviewer: string | null;
  /** One per dimension, in {@link PLAN_REVIEW_DIMENSIONS} order; empty unless `reviewed`. */
  results: PlanReviewResult[];
  /** Why it was skipped or did not run. */
  reason?: string;
  /** 1 for the first review since the plan last reached the person; +1 per draft sent back. */
  round: number;
  /** This draft went back to the director with the notes instead of to the person. */
  sentBack: boolean;
  /** {@link planReviewBasis} of what was reviewed: a plan whose rows changed since reads as not re-reviewed. */
  basis: string;
  /** The review call's priced cost; null when unpriced or no call was made. */
  costUsd: number | null;
}

export const PLAN_REVIEW_DETAIL_MAX = 400;
export const PLAN_REVIEW_REASON_MAX = 300;
export const PLAN_REVIEW_TASK_IDS_MAX = 50;
const ROUND_MAX = 20;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const flat = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
};

/** What a review read: each task's id, title, milestone, worker, checks and cited decisions, and the milestone order. */
export function planReviewBasis(rows: readonly AssignmentRow[], milestoneIds: readonly string[]): string {
  const text = JSON.stringify([milestoneIds, rows.map((r) => [r.taskId, r.title, r.milestoneId, r.worker, r.checks ?? [], r.decisions ?? []])]);
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function readResult(raw: unknown): PlanReviewResult | undefined {
  if (!isObject(raw)) return undefined;
  if (!PLAN_REVIEW_DIMENSIONS.includes(raw.dimension as PlanReviewDimension)) return undefined;
  if (raw.verdict !== "pass" && raw.verdict !== "warn" && raw.verdict !== "fail") return undefined;
  if (typeof raw.detail !== "string") return undefined;
  if (!Array.isArray(raw.taskIds) || raw.taskIds.length > PLAN_REVIEW_TASK_IDS_MAX) return undefined;
  if (!raw.taskIds.every((t) => typeof t === "string" && t.length > 0 && t.length <= 64)) return undefined;
  return { dimension: raw.dimension as PlanReviewDimension, verdict: raw.verdict, detail: flat(raw.detail, PLAN_REVIEW_DETAIL_MAX), taskIds: [...new Set(raw.taskIds as string[])] };
}

/** A stored {@link PlanReviewRecord}, or undefined when malformed (it then reads as no review). */
export function readPlanReviewRecord(raw: unknown): PlanReviewRecord | undefined {
  if (!isObject(raw)) return undefined;
  if (raw.outcome !== "reviewed" && raw.outcome !== "skipped" && raw.outcome !== "not-run") return undefined;
  if (raw.reviewer !== null && (typeof raw.reviewer !== "string" || raw.reviewer.length === 0 || raw.reviewer.length > 200)) return undefined;
  if (typeof raw.basis !== "string" || !/^[0-9a-f]{16}$/.test(raw.basis)) return undefined;
  if (!Number.isInteger(raw.round) || (raw.round as number) < 1 || (raw.round as number) > ROUND_MAX) return undefined;
  if (typeof raw.sentBack !== "boolean") return undefined;
  if (raw.costUsd !== null && (typeof raw.costUsd !== "number" || !Number.isFinite(raw.costUsd) || raw.costUsd < 0)) return undefined;
  if (!Array.isArray(raw.results) || raw.results.length > PLAN_REVIEW_DIMENSIONS.length) return undefined;
  const results: PlanReviewResult[] = [];
  for (const r of raw.results) {
    const read = readResult(r);
    if (read === undefined || results.some((x) => x.dimension === read.dimension)) return undefined;
    results.push(read);
  }
  if (raw.outcome === "reviewed" && results.length !== PLAN_REVIEW_DIMENSIONS.length) return undefined;
  if (raw.outcome !== "reviewed" && results.length > 0) return undefined;
  if (raw.reason !== undefined && typeof raw.reason !== "string") return undefined;
  return {
    outcome: raw.outcome,
    reviewer: raw.reviewer as string | null,
    results,
    ...(typeof raw.reason === "string" && raw.reason.trim().length > 0 ? { reason: flat(raw.reason, PLAN_REVIEW_REASON_MAX) } : {}),
    round: raw.round as number,
    sentBack: raw.sentBack,
    basis: raw.basis,
    costUsd: raw.costUsd as number | null,
  };
}

/** The plan as the record reads it: its rows, its review, and the milestones' order. */
export interface ReviewedPlan {
  rows: readonly AssignmentRow[];
  review?: PlanReviewRecord;
}

/**
 * What the facts floor reads, recomputed whenever a review is used (the
 * gate, a decision, `project.plan`), never stored with it: the approved
 * criteria and the deterministic plan checks as they stand now (a
 * decision the person deferred since no longer fails `decisions`).
 */
export interface PlanReviewFacts {
  criteria: readonly { id: string }[];
  planChecks: readonly PlanCheckResult[];
}

/**
 * Facts the reviewer cannot pass over (the judge's rule: a model only
 * adds red): an approved criterion no task check names fails
 * `criteria-coverage`; a task with no check fails `verifiability`; a
 * deterministic `decision-coverage` failure fails `decisions`. The
 * reviewer's own notes stay beside the fact's.
 */
export function withPlanFacts(results: readonly PlanReviewResult[], rows: readonly AssignmentRow[], facts: PlanReviewFacts): PlanReviewResult[] {
  const named = new Set(rows.flatMap((r) => (r.checks ?? []).flatMap((c) => c.criteria ?? [])));
  const uncovered = facts.criteria.filter((c) => !named.has(c.id)).map((c) => c.id);
  const bare = rows.filter((r) => (r.checks?.length ?? 0) === 0).map((r) => r.taskId);
  const decisionFail = facts.planChecks.find((c) => c.dimension === "decision-coverage" && c.verdict === "fail");
  const floor = (r: PlanReviewResult, fact: string, taskIds: readonly string[]): PlanReviewResult => ({
    ...r,
    verdict: "fail",
    detail: (r.verdict === "fail" ? `${fact} ${r.detail}` : fact).slice(0, PLAN_REVIEW_DETAIL_MAX),
    taskIds: [...new Set([...taskIds, ...(r.verdict === "fail" ? r.taskIds : [])])].slice(0, PLAN_REVIEW_TASK_IDS_MAX),
  });
  return results.map((r) => {
    if (r.dimension === "criteria-coverage" && uncovered.length > 0) return floor(r, `No task check names approved criteria: ${uncovered.join(", ")}.`, []);
    if (r.dimension === "verifiability" && bare.length > 0) return floor(r, `Tasks without an executable check: ${bare.join(", ")}.`, bare);
    if (r.dimension === "decisions" && decisionFail !== undefined) return floor(r, decisionFail.detail, decisionFail.taskIds);
    return r;
  });
}

/** Whether the stored review read these rows (and milestone order). */
export function planReviewFresh(plan: ReviewedPlan, milestoneIds: readonly string[]): boolean {
  return plan.review !== undefined && plan.review.basis === planReviewBasis(plan.rows, milestoneIds);
}

/** A fresh review's results with the facts floor applied now; undefined for a stale, absent or unanswered one. */
export function effectivePlanReview(plan: ReviewedPlan | undefined, milestoneIds: readonly string[], facts: PlanReviewFacts): PlanReviewResult[] | undefined {
  if (plan?.review === undefined || plan.review.outcome !== "reviewed" || !planReviewFresh(plan, milestoneIds)) return undefined;
  return withPlanFacts(plan.review.results, plan.rows, facts);
}

/** The reviewer's failures still standing on the plan: a fresh review's `fail` results (facts floor included); none for a stale or absent one. */
export function openPlanReviewFails(plan: ReviewedPlan | undefined, milestoneIds: readonly string[], facts: PlanReviewFacts): PlanReviewResult[] {
  return (effectivePlanReview(plan, milestoneIds, facts) ?? []).filter((r) => r.verdict === "fail");
}

export const planReviewLine = (r: PlanReviewResult): string =>
  `plan review: ${r.dimension}: ${r.verdict}: ${r.detail}${r.taskIds.length === 0 ? "" : ` (${r.taskIds.join(", ")})`}`;

/** The open failures as review blocks (the `review-open` refusal and the person's override record). */
export function planReviewBlocks(plan: ReviewedPlan | undefined, milestoneIds: readonly string[], facts: PlanReviewFacts): ProjectReviewBlock[] {
  return openPlanReviewFails(plan, milestoneIds, facts).flatMap((r) =>
    (r.taskIds.length === 0 ? ["plan"] : r.taskIds).map((taskId) => ({ taskId, reason: flat(planReviewLine(r), PLAN_REVIEW_DETAIL_MAX) })));
}

/** One line per dimension count: "8 dimensions: 5 pass, 1 warn, 2 fail". */
function tally(results: readonly PlanReviewResult[]): string {
  const n = (v: PlanReviewResult["verdict"]) => results.filter((r) => r.verdict === v).length;
  return `${n("pass")} pass, ${n("warn")} warn, ${n("fail")} fail`;
}

/** What the plan gate says about the review, and whether an automatic approval may go ahead. */
export interface PlanReviewGate {
  hints: string[];
  /**
   * False when automation (`--auto-approve-project`) must stop for a
   * person: open fails, or (with a plan reviewer configured) a plan that
   * was not reviewed. The person may still approve with what they see.
   */
  autoApprovable: boolean;
}

/**
 * The plan gate's lines for the review: a summary, then every dimension
 * that is not a pass. A stale review says so instead of its results; a
 * skipped review or one that did not run says the plan was not reviewed,
 * and why. `configured`: whether a plan reviewer is configured now.
 */
export function planReviewGate(plan: ReviewedPlan | undefined, milestoneIds: readonly string[], facts: PlanReviewFacts, configured: boolean): PlanReviewGate {
  const review = plan?.review;
  if (review === undefined) return { hints: [], autoApprovable: true };
  const by = review.reviewer === null ? "" : ` by ${review.reviewer}`;
  if (review.outcome === "skipped") return { hints: [`plan not reviewed: the review was skipped: ${review.reason ?? "no plan reviewer could be used"}`], autoApprovable: !configured };
  if (review.outcome === "not-run") return { hints: [`plan not reviewed: ${review.reason ?? "no answer"}${by === "" ? "" : ` (asked${by})`}; this is not a pass`], autoApprovable: !configured };
  const results = effectivePlanReview(plan, milestoneIds, facts);
  if (results === undefined) {
    return { hints: [`plan review is stale: the tasks changed since review ${review.round}${by}; it was not run again (draft the plan again to review it)`], autoApprovable: true };
  }
  const fails = results.some((r) => r.verdict === "fail");
  const head = `plan review ${review.round}${by}: ${tally(results)}${fails ? "; open notes below: approve over them only with a note (approveOverReview)" : ""}`;
  return { hints: [head, ...results.filter((r) => r.verdict !== "pass").map(planReviewLine)], autoApprovable: !fails };
}

/** {@link planReviewGate}'s lines alone. */
export function planReviewHints(plan: ReviewedPlan | undefined, milestoneIds: readonly string[], facts: PlanReviewFacts, configured = true): string[] {
  return planReviewGate(plan, milestoneIds, facts, configured).hints;
}
