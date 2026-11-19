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
  /** Whether `llm.runMode.fusion.team.reviewers` names anyone; absent: whether any reviewer is selectable. */
  reviewersConfigured?: boolean;
  /**
   * Whether the team names a member besides the one worker (another
   * worker, or any reviewer), reachable now or not; absent: as
   * `reviewersConfigured`. Picks which hint explains a plan with nothing
   * to choose.
   */
  otherMembersConfigured?: boolean;
}

/** The plan gate's hint when the team names no reviewers (issue #54). */
export const NO_REVIEWERS_HINT = "no reviewers configured: add llm.runMode.fusion.team.reviewers to have each task reviewed";
/** The plan gate's hint when "edit rows" would offer nothing to choose (issue #54). */
export const ONE_WORKER_HINT = "only one worker available: configure llm.runMode.fusion.team to choose";
/** The same, when the team names other members but none can answer now (issue #54). */
export const NONE_REACHABLE_HINT = "no other team member is reachable now: the rows keep their worker";

/** The plan gate's hint for a milestone the draft starts over on new work, its earlier result in history (issue #77). */
export const verdictResetHint = (title: string): string => `verdict reset: ${title}`;

/** The plan gate's hint for a milestone that kept its verdict but lost its criteria evidence to history (issue #83). */
export const evidenceRetiredHint = (title: string): string => `evidence retired: ${title}`;

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
  const rows = (plan?.rows ?? []).map((row) => ({
    ...row,
    selectableWorkers: [...input.selectable.workers],
    selectableReviewers: input.selectable.reviewers.filter((r) => r !== row.worker),
  }));
  // Nothing to choose: every row's only worker is its own, no reviewer.
  const editable = rows.some((row) =>
    row.selectableReviewers.length > 0 || row.selectableWorkers.some((w) => w !== row.worker));
  const hints: string[] = [];
  if (project.gate.kind === "plan" && plan !== undefined) {
    if (!(input.reviewersConfigured ?? input.selectable.reviewers.length > 0)) hints.push(NO_REVIEWERS_HINT);
    if (!editable) {
      const others = input.otherMembersConfigured ?? input.reviewersConfigured ?? false;
      hints.push(others ? NONE_REACHABLE_HINT : ONE_WORKER_HINT);
    }
    // Issue #77: the person approves a plan that starts these over.
    for (const id of plan.verdictResets ?? []) {
      const m = project.milestones.find((x) => x.id === id);
      if (m !== undefined) hints.push(verdictResetHint(m.title));
    }
    // Issue #83: these keep their verdict, but their criteria evidence went to history.
    for (const id of plan.evidenceRetired ?? []) {
      const m = project.milestones.find((x) => x.id === id);
      if (m !== undefined) hints.push(evidenceRetiredHint(m.title));
    }
  }
  return {
    schema: 1,
    sessionId: input.sessionId,
    gate: project.gate,
    version: gateVersion(project),
    allowedVerdicts: project.cancelledAt !== undefined ? [] : allowedProjectVerdicts(project.gate),
    expectation: projectExpectation(project),
    cancelled: project.cancelledAt !== undefined,
    brief:
      project.brief === undefined
        ? null
        : { ...project.brief, successCriteria: project.brief.successCriteria.map((c) => c.text), criteria: project.brief.successCriteria.map((c) => ({ ...c })) },
    plan:
      plan === undefined
        ? null
        : {
            status: plan.status,
            detail: plan.detail,
            version: plan.version,
            draftedAfterUntrusted: plan.draftedAfterUntrusted,
            rows,
            totals: estimate?.totals ?? plan.totals,
            editable,
          },
    milestones: project.milestones.map((m) => ({
      ...m,
      estCostUsd: byMilestone.get(m.id)?.costUsd ?? null,
      estMs: byMilestone.get(m.id)?.ms ?? null,
    })),
    violations,
    hints,
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
