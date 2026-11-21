import { createHash } from "node:crypto";

import type { AssignmentRow, ProjectBriefDecision, ProjectCriterion, ProjectDecisionStatus, ProjectReviewBlock } from "../../session/session-project.js";
import { lintContractCheck } from "./contract-check-lint.js";

export type PlanCheckDimension = "check-lint" | "criteria-coverage" | "verifiability" | "decision-coverage";
export interface PlanCheckResult {
  dimension: PlanCheckDimension;
  verdict: "pass" | "warn" | "fail";
  detail: string;
  taskIds: string[];
}
export interface PlanCheckOptions {
  /** Caller's policy: promote warnings to failures for these dimensions. */
  blockingDimensions?: readonly PlanCheckDimension[];
}

/** A decision of the last approved brief with the person's status for it (issue #112). */
export interface PlanDecision extends ProjectBriefDecision {
  status: ProjectDecisionStatus;
}

/**
 * Issue #112: every `active` decision must be cited by a plan task's
 * `decisions`; one that is not fails, whatever the caller's policy (the
 * person can defer it at the plan gate). Absent when the brief has none.
 */
function decisionCoverage(rows: readonly AssignmentRow[], decisions: readonly PlanDecision[], finished: ReadonlyMap<string, readonly string[]>): PlanCheckResult[] {
  // A citation of an id that is no decision is a slip, not a block: warn, naming it per task.
  const known = new Set(decisions.map((d) => d.id));
  const strays = rows.flatMap((r) => {
    const unknown = (r.decisions ?? []).filter((id) => !known.has(id));
    return unknown.length === 0 ? [] : [{ taskId: r.taskId, unknown }];
  });
  const stray: PlanCheckResult[] = strays.length === 0 ? [] : [{
    dimension: "decision-coverage",
    verdict: "warn",
    detail: `Tasks cite ids that are no decision of the approved brief: ${strays.map((s) => `${s.taskId} (${s.unknown.join(", ")})`).join(", ")}.`,
    taskIds: strays.map((s) => s.taskId),
  }];
  if (decisions.length === 0) return stray;
  // A done or reviewed milestone's task counts only for what it cited when it ran (its snapshot):
  // a citation added to it since names work that will not run again.
  const cited = new Set([
    ...rows.filter((r) => !finished.has(r.milestoneId)).flatMap((r) => r.decisions ?? []),
    ...[...finished.values()].flat(),
  ]);
  const missing = decisions.filter((d) => d.status === "active" && !cited.has(d.id));
  const late = (id: string) => rows
    .filter((r) => finished.has(r.milestoneId) && (r.decisions ?? []).includes(id))
    .map((r) => ` ${r.taskId} is in a finished milestone (${r.milestoneId}); cite ${id} on a task that will run.`)
    .join("");
  const excluded = decisions.filter((d) => d.status !== "active");
  const aside = excluded.length === 0 ? "" : ` Not checked: ${excluded.map((d) => `${d.id} (${d.status})`).join(", ")}.`;
  return [...stray, missing.length === 0
    ? { dimension: "decision-coverage", verdict: "pass", detail: `Every active decision is cited by a plan task.${aside}`, taskIds: [] }
    : { dimension: "decision-coverage", verdict: "fail", detail: `No plan task that will run cites active decisions: ${missing.map((d) => `${d.id} (${d.text})`).join(", ")}. Cite each on a task's decisions, or the person defers it at the plan gate.${missing.map((d) => late(d.id)).join("")}${aside}`, taskIds: [] }];
}

/**
 * Static analysis only. Criteria and decisions must come from the last
 * approved brief; `finished` maps each done or reviewed milestone to the
 * decision ids its tasks cited when it ran (`decisionsCited`).
 */
export function evaluatePlanChecks(
  rows: readonly AssignmentRow[],
  criteria: readonly ProjectCriterion[],
  options: PlanCheckOptions = {},
  decisions: readonly PlanDecision[] = [],
  finished: ReadonlyMap<string, readonly string[]> = new Map(),
): PlanCheckResult[] {
  const checked = rows.filter((r) => (r.checks?.length ?? 0) > 0);
  const findings = checked.flatMap((row) => row.checks!.flatMap((check, i) =>
    lintContractCheck(check, i).map((finding) => ({ row, finding }))));
  const lint: PlanCheckResult[] = findings.length === 0
    ? [{ dimension: "check-lint", verdict: "pass", detail: "No static check lint findings.", taskIds: checked.map((r) => r.taskId) }]
    : findings.map(({ row, finding }) => ({ dimension: "check-lint", verdict: finding.severity === "severe" ? "fail" : "warn", detail: `${row.taskId}: ${finding.where} ${finding.message}`, taskIds: [row.taskId] }));
  const covered = new Set(checked.flatMap((r) => r.checks!.flatMap((c) => c.criteria ?? [])));
  const missing = criteria.filter((c) => !covered.has(c.id));
  const bare = checked.length === 0 ? [] : rows.filter((r) => (r.checks?.length ?? 0) === 0).map((r) => r.taskId);
  const results: PlanCheckResult[] = [
    ...lint,
    { dimension: "criteria-coverage", verdict: missing.length === 0 ? "pass" : "warn", detail: missing.length === 0 ? "Every approved criterion is named by a plan check." : `No plan check names approved criteria: ${missing.map((c) => c.id).join(", ")}.`, taskIds: [] },
    { dimension: "verifiability", verdict: bare.length === 0 ? "pass" : "warn", detail: bare.length === 0 ? "No task is missing checks in a plan that uses them." : `Tasks without checks: ${bare.join(", ")}.`, taskIds: bare },
    ...decisionCoverage(rows, decisions, finished),
  ];
  return results.map((r) => r.verdict === "warn" && options.blockingDimensions?.includes(r.dimension) ? { ...r, verdict: "fail" } : r);
}

/**
 * Issue #120: the `references` dimension, computed by the runtime when
 * the plan is drafted (`plan-references.ts`, which reads the project
 * folder) and kept on the plan as a record. `basis` is
 * {@link planReferenceBasis} of the rows it read: a record whose basis no
 * longer matches the rows is reported as not re-checked. Never blocking.
 */
export interface PlanReferenceRecord {
  verdict: "pass" | "warn";
  detail: string;
  taskIds: string[];
  basis: string;
}

/** What the references were read from: each task's id, title and checks. */
export function planReferenceBasis(rows: readonly AssignmentRow[]): string {
  const text = JSON.stringify(rows.map((r) => [r.taskId, r.title, r.checks ?? []]));
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export const planCheckHint = (r: PlanCheckResult): string => `${r.dimension}: ${r.verdict}: ${r.detail}`;

/** Feed failures through the same review-open mechanism as milestone review blocks. */
export function planCheckReviewBlocks(results: readonly PlanCheckResult[]): ProjectReviewBlock[] {
  return results.filter((r) => r.verdict === "fail").flatMap((r) =>
    (r.taskIds.length === 0 ? ["plan"] : r.taskIds).map((taskId) => ({ taskId, reason: planCheckHint(r) })));
}
