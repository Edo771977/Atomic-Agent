import {
  allowedProjectVerdicts,
  gateVersion,
  projectExpectation,
  type AssignmentRow,
  type PlanDetail,
  type ProjectBrief,
  type ProjectExpectation,
  type ProjectGate,
  type ProjectMilestone,
  type ProjectPlanTotals,
  type ProjectState,
  type ProjectVerdict,
} from "../../session/session-project.js";
import { describeViolation, type PlanEstimate, type PlanViolation } from "./project-estimate.js";

/**
 * The structured project a surface draws its gate card from (issue #39):
 * the TUI card and `/plan`, the CLI's printed gate, the HTTP route and
 * the sidecar's `project_gate` event all render this one shape, so they
 * cannot disagree about what is being approved. Built by
 * {@link projectGateView}, pure; the runtime fills the live parts
 * (estimates from the current team, prices and limits; the members the
 * person may pick per row).
 *
 * A decision is sent back as `ProjectDecision { gate, version, verdict,
 * edits? }` with `gate` and `version` copied from this view.
 */
export interface ProjectGateView {
  /** Payload version of this shape; bumped on an incompatible change. */
  schema: 1;
  sessionId: string;
  /** What waits on the person. */
  gate: ProjectGate;
  /** `gateVersion`: the number a decision must carry; null when nothing can be decided. */
  version: number | null;
  /** The buttons the card draws. */
  allowedVerdicts: ProjectVerdict[];
  /** What happens next (`projectExpectation`). */
  expectation: ProjectExpectation;
  cancelled: boolean;
  brief: ProjectBrief | null;
  plan: {
    status: "draft" | "approved" | "cancelled";
    /** The default detail; `/plan` shows full regardless. */
    detail: PlanDetail;
    version: number;
    rows: ProjectGateRow[];
    /** Wave-aware totals (`estimatePlan`): cost summed, time over milestones in order. */
    totals: ProjectPlanTotals;
  } | null;
  milestones: ProjectGateMilestone[];
  /** Every limit the plan breaks, hard ones first; approve is refused while any hard one stands. */
  violations: ProjectGateViolation[];
}

export interface ProjectGateRow extends AssignmentRow {
  /** Workers the person may pick for this row: team workers the folder's policy allows and that can answer. */
  selectableWorkers: string[];
  /** Reviewers the person may pick (null — no review — is always allowed). */
  selectableReviewers: string[];
}

export interface ProjectGateMilestone extends ProjectMilestone {
  /** The milestone's estimate (`estimatePlan`); null when unknown. */
  estCostUsd: number | null;
  estMs: number | null;
}

export interface ProjectGateViolation {
  kind: PlanViolation["kind"];
  severity: "hard" | "warn";
  /** One line for the card (`describeViolation`). */
  message: string;
  milestoneId?: string;
  taskId?: string;
}

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
