/**
 * The structured project a surface draws its gate card from (issue #39):
 * the TUI card and `/plan`, the CLI's printed gate, the HTTP route, the
 * sidecar's `project_gate` event (the desktop card) and the Telegram text
 * all render this one shape, so they cannot disagree about what is being
 * approved. Types only, here so every surface may import them; the
 * runtime builds the view with `projectGateView`
 * (`tools/fusion/project-gate-view.ts`, pure) from `SessionState.project`
 * ([session-project.ts](session-project.ts)) and the live estimates, and
 * announces it as the `project_gate` event.
 *
 * Surfaces render the buttons from `allowedVerdicts`, never a fixed list,
 * and pick a row's worker or reviewer only among its `selectableWorkers`
 * / `selectableReviewers`. A decision is sent back as
 * `ProjectDecision { gate, version, verdict, edits? }` with `gate` and
 * `version` copied from this view; the milestone gate's correction is
 * `edits.note`.
 */

import type {
  AssignmentRow,
  PlanDetail,
  ProjectBrief,
  ProjectCriterion,
  ProjectDecisionStatus,
  ProjectExpectation,
  ProjectGate,
  ProjectMilestone,
  ProjectPlanTotals,
  ProjectVerdict,
} from "./session-project.js";

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
  brief: ProjectGateBrief | null;
  plan: ProjectGatePlan | null;
  milestones: ProjectGateMilestone[];
  /** Every limit the plan breaks, hard ones first; approve is refused while any hard one stands. */
  violations: ProjectGateViolation[];
  /**
   * One-line advice for the card (issue #54), shown as is: at the plan
   * gate, that no reviewers are configured, or that there is only one
   * worker to choose. Empty when there is nothing to say; never a limit
   * (those are `violations`).
   */
  hints: string[];
  /**
   * Issue #112: the brief's decisions with the person's status for each
   * and the plan tasks that cite them. Absent when the brief has none.
   * At the plan gate an `active` decision no task cites blocks approval;
   * the person may send `edit` with `edits.decisionStatus` to defer it.
   */
  decisions?: ProjectGateDecision[];
  /**
   * Issue #109: the open gate's content changed outside Atomic Agent since
   * the person last decided it (`project.json` edited by hand or by a
   * command), or no decision is recorded on this machine. Absent
   * otherwise. An automatic approval stops here for the person.
   */
  changedOutside?: true;
}

/**
 * The brief as the card shows it. `successCriteria` stays the criteria's
 * texts (what surfaces before issue #40 read); `criteria` carries each
 * with its id, the name contract checks and facts use.
 */
export interface ProjectGateBrief extends Omit<ProjectBrief, "successCriteria"> {
  successCriteria: string[];
  criteria: ProjectCriterion[];
}

/** A brief decision as the card shows it (issue #112). */
export interface ProjectGateDecision {
  id: string;
  text: string;
  status: ProjectDecisionStatus;
  /** Plan task ids whose `decisions` cite it; empty without a plan. */
  citedBy: string[];
}

export interface ProjectGatePlan {
  status: "draft" | "approved" | "cancelled";
  /** The default detail; `/plan` shows full regardless. */
  detail: PlanDetail;
  version: number;
  /** Drafted after outside content entered the chat: show the warning before approving. */
  draftedAfterUntrusted: boolean;
  rows: ProjectGateRow[];
  /** Wave-aware totals (`estimatePlan`): cost summed, time over milestones in order. */
  totals: ProjectPlanTotals;
  /**
   * Whether "edit rows" offers a choice (issue #54): false when every row
   * has only its current worker selectable and no reviewer to pick. A
   * surface hides or disables its edit action then; `edit` stays in
   * `allowedVerdicts`.
   */
  editable: boolean;
}

export interface ProjectGateRow extends AssignmentRow {
  /** Workers the person may pick for this row: team workers the folder's policy allows and that can answer. */
  selectableWorkers: string[];
  /** Reviewers the person may pick (null — no review — is always allowed). */
  selectableReviewers: string[];
}

/**
 * A milestone as stored, with its estimate. From issue #40 it may carry
 * `attachments` (screenshots of the result: `path` is absolute, inside
 * the run's shots folder; a surface shows the caption and the path and
 * renders the image only through its own safe file read) and
 * `criteriaFacts` (per success criterion id: passed, failed or
 * unverified, with a one-line why). Both are optional and additive.
 * From issue #77 it may carry `history`, the evidence of earlier work a
 * re-plan replaced (optional, additive; not the current result).
 */
export interface ProjectGateMilestone extends ProjectMilestone {
  /** The milestone's estimate (`estimatePlan`); null when unknown. */
  estCostUsd: number | null;
  estMs: number | null;
}

/** `PlanViolation.kind` (`tools/fusion/project-estimate.ts`). */
export type ProjectGateViolationKind = "turn-budget" | "daily-limit" | "local-slots" | "folder-policy";

export interface ProjectGateViolation {
  kind: ProjectGateViolationKind;
  severity: "hard" | "warn";
  /** One line for the card (`describeViolation`). */
  message: string;
  milestoneId?: string;
  taskId?: string;
}
