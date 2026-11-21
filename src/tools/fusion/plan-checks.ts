import type { AssignmentRow, ProjectCriterion, ProjectReviewBlock } from "../../session/session-project.js";
import { lintContractCheck } from "./contract-check-lint.js";

export type PlanCheckDimension = "check-lint" | "criteria-coverage" | "verifiability";
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

/** Static analysis only. Criteria must come from the last approved brief. */
export function evaluatePlanChecks(rows: readonly AssignmentRow[], criteria: readonly ProjectCriterion[], options: PlanCheckOptions = {}): PlanCheckResult[] {
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
  ];
  return results.map((r) => r.verdict === "warn" && options.blockingDimensions?.includes(r.dimension) ? { ...r, verdict: "fail" } : r);
}

export const planCheckHint = (r: PlanCheckResult): string => `${r.dimension}: ${r.verdict}: ${r.detail}`;

/** Feed failures through the same review-open mechanism as milestone review blocks. */
export function planCheckReviewBlocks(results: readonly PlanCheckResult[]): ProjectReviewBlock[] {
  return results.filter((r) => r.verdict === "fail").flatMap((r) =>
    (r.taskIds.length === 0 ? ["plan"] : r.taskIds).map((taskId) => ({ taskId, reason: planCheckHint(r) })));
}
