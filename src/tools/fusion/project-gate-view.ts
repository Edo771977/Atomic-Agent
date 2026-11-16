import {
  allowedProjectVerdicts,
  gateVersion,
  projectExpectation,
  type ProjectState,
} from "../../session/session-project.js";
import { describeViolation, type PlanEstimate, type PlanViolation } from "./project-estimate.js";
import type { ProjectGateView, ProjectGateViolation, ProjectGateViolationKind } from "../../session/project-gate-view.js";

/**
 * Builds the {@link ProjectGateView} every surface draws (issue #39). The
 * types live in `session/project-gate-view.ts` so surfaces can import
 * them; this file only fills them, pure.
 */

// The view's violation kinds must stay the estimator's.
type _SameKinds = [PlanViolation["kind"]] extends [ProjectGateViolationKind]
  ? [ProjectGateViolationKind] extends [PlanViolation["kind"]] ? true : never
  : never;
const _sameKinds: _SameKinds = true;
void _sameKinds;

export interface ProjectGateViewInput {
  sessionId: string;
  project: ProjectState;
  /** `estimatePlan` of the plan's rows with live limits; null without a plan. */
  estimate: PlanEstimate | null;
  /** The members the person may pick, in config order. */
  selectable: { workers: readonly string[]; reviewers: readonly string[] };
}

/** The gate card's payload. Pure. */
export function projectGateView(input: ProjectGateViewInput): ProjectGateView {
  const { project, estimate } = input;
  const plan = project.plan;
  const byMilestone = new Map((estimate?.milestones ?? []).map((m) => [m.id, m]));
  const violations: ProjectGateViolation[] = (estimate?.violations ?? [])
    .map((v) => ({
      kind: v.kind,
      severity: v.severity,
      message: describeViolation(v),
      ...("milestoneId" in v ? { milestoneId: v.milestoneId } : {}),
      ...("taskId" in v ? { taskId: v.taskId } : {}),
    }))
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "hard" ? -1 : 1));
  return {
    schema: 1,
    sessionId: input.sessionId,
    gate: project.gate,
    version: gateVersion(project),
    allowedVerdicts: project.cancelledAt !== undefined ? [] : allowedProjectVerdicts(project.gate),
    expectation: projectExpectation(project),
    cancelled: project.cancelledAt !== undefined,
    brief: project.brief ?? null,
    plan:
      plan === undefined
        ? null
        : {
            status: plan.status,
            detail: plan.detail,
            version: plan.version,
            rows: plan.rows.map((row) => ({
              ...row,
              selectableWorkers: [...input.selectable.workers],
              selectableReviewers: input.selectable.reviewers.filter((r) => r !== row.worker),
            })),
            totals: estimate?.totals ?? plan.totals,
          },
    milestones: project.milestones.map((m) => ({
      ...m,
      estCostUsd: byMilestone.get(m.id)?.costUsd ?? null,
      estMs: byMilestone.get(m.id)?.ms ?? null,
    })),
    violations,
  };
}

/** Whether a surface should be told: the gate or the number it decides against moved. */
export function projectGateChanged(before: ProjectState | undefined, after: ProjectState | undefined): boolean {
  if (before === after) return false;
  if (before === undefined || after === undefined) return true;
  const a = before.gate;
  const b = after.gate;
  return (
    a.kind !== b.kind ||
    (a.kind === "milestone" && b.kind === "milestone" && a.id !== b.id) ||
    gateVersion(before) !== gateVersion(after) ||
    before.cancelledAt !== after.cancelledAt
  );
}
