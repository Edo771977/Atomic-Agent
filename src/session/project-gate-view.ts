/**
 * The structured project a surface draws its gate card from (issue #39):
 * the TUI card and `/plan`, the CLI's printed gate, the HTTP route, the
 * sidecar's `project_gate` event (the desktop card) and the Telegram text
 * all render this one shape, so they cannot disagree about what is being
 * approved. The runtime builds the view with `projectGateView`
 * (`tools/fusion/project-gate-view.ts`) from `SessionState.project`
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
  ProjectBacklogItem,
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
  /**
   * Issue #118: the plan reviewer's last review of this plan, at the plan
   * gate only; absent without one. `stale`: the rows changed since, so its
   * results no longer describe the plan and block nothing. A fresh
   * review's `fail` results block a plain approval; `approveOverReview`
   * (in `allowedVerdicts` then) approves over them with a note.
   */
  planReview?: ProjectGatePlanReview;
  /**
   * Issue #111: the project's backlog; absent when it holds no item.
   * Additive. `open` counts items nobody decided on; `seeds` are the open
   * ones with a condition (shown with it at plan and milestone gates, as
   * `hints` too); `promoted` waits for the next plan the person approves.
   * Promote or drop goes through `runtime.projectBacklogDecision`, never a
   * gate verdict. Issue #146: at the plan gate a promoted item no task
   * cites blocks approval (`backlog-coverage`); the person may send
   * `edit` with `edits.backlogStatus` to defer it.
   */
  backlog?: ProjectGateBacklog;
}

/**
 * The backlog as a card shows it (issue #111). New views include
 * fingerprints on items and stale calls; older views may omit them.
 */
export interface ProjectGateBacklog {
  open: number;
  seeds: Array<{ id: string; title: string; condition: string }>;
  /**
   * Issue #146: `deferred` when the person deferred it at the plan gate
   * (still promoted, not required in the plan); `citedBy`, the plan's
   * tasks whose `backlog` cites it.
   */
  promoted: Array<{ id: string; title: string; deferred?: true; citedBy?: string[] }>;
  /** The person's calls that no longer stand: the item changed outside Atomic Agent since (it reads open), or a promoted one was removed. */
  stale: Array<{ id: string; state: "promoted" | "dropped"; reason: "changed" | "removed"; fingerprint?: string }>;
  /** Every item with the person's call on it (`open` when none); `plannedIn`: the approved plan version that took a promoted one in. */
  items: Array<ProjectBacklogItem & { state: "open" | "promoted" | "dropped"; plannedIn?: number; deferred?: true; fingerprint?: string }>;
}

/** The plan reviewer's notes as the card shows them (issue #118). */
export interface ProjectGatePlanReview {
  /** `missing`: a plan reviewer is configured but no review is recorded for this plan (an outside edit, another machine). */
  outcome: "reviewed" | "skipped" | "not-run" | "missing";
  reviewer: string | null;
  /** One per dimension, same shape as a plan check result; empty unless reviewed. */
  results: Array<{ dimension: string; verdict: "pass" | "warn" | "fail"; detail: string; taskIds: string[] }>;
  reason?: string;
  round: number;
  stale: boolean;
  /**
   * False when an automatic approval (`--auto-approve-project`) must stop
   * here for a person: open fails, or a plan reviewer is configured and
   * this plan was not reviewed. A person may still approve.
   */
  autoApprovable: boolean;
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

export interface ProjectCriterionBasisSummary {
  check: number;
  vision: number;
  person: number;
  unrecorded: number;
}

export interface MilestoneEvidenceReceipts {
  /** Project folder to pass to the full receipt verifier. */
  folder?: string;
  valid: number;
  unsigned: number;
  problems: number;
  /** Only a bounded part of the receipt archive was checked. */
  partial?: true;
  archiveUnavailable?: true;
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
  /** Counts of reported criterion facts by basis. */
  criteriaBasisSummary?: ProjectCriterionBasisSummary;
  /** Sentences in the director report with a verification claim and no matching passed fact. */
  directorReportWarnings?: string[];
  /** Receipt verification for the milestone awaiting review. */
  evidenceReceipts?: MilestoneEvidenceReceipts;
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

/** Materialize the active milestone's lazy summary for an opt-in wire response. */
export function withProjectGateEvidence(view: ProjectGateView): ProjectGateView {
  if (view.gate.kind !== "milestone") return view;
  const { id } = view.gate;
  const milestone = view.milestones.find(m => m.id === id);
  const evidenceReceipts = milestone?.evidenceReceipts;
  if (evidenceReceipts === undefined) return view;
  return {
    ...view,
    milestones: view.milestones.map(m => m === milestone ? { ...m, evidenceReceipts } : m),
  };
}
