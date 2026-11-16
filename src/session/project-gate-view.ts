/**
 * The structured view of a fusion project's gate (issue #39) that every
 * surface draws: the TUI card, the CLI summary, `GET /api/project`, the
 * sidecar `project_gate` event (the desktop card) and the Telegram text.
 * Types only: the runtime builds it from `SessionState.project`
 * ([session-project.ts](session-project.ts)) and the live estimates
 * (`tools/fusion/project-estimate.ts`), and announces it as the
 * `project_gate` event; surfaces send the person's verdict back through
 * `AgentRuntime.projectDecision` against `version`.
 *
 * Surfaces render the buttons from `allowedVerdicts`, never a fixed
 * list, and pick a row's worker or reviewer only among `selectable`.
 */

import type {
  AssignmentRow,
  PlanDetail,
  ProjectBrief,
  ProjectDecision,
  ProjectExpectation,
  ProjectGate,
  ProjectMilestone,
  ProjectPlanTotals,
  ProjectVerdict,
} from "./session-project.js";

/** One plan row with the team members the person may pick for it. */
export type ProjectGateRow = AssignmentRow & {
  /**
   * Member refs (`"<providerId>:<model>"`) reachable now and allowed by
   * the folder's policy, per role. A reviewer may also be `null` (no
   * review), which is not listed here.
   */
  selectable: { worker: string[]; reviewer: string[] };
};

export interface ProjectGateViolation {
  /** `PlanViolation.kind` (`turn-budget`, `daily-limit`, `local-slots`, `folder-policy`). */
  kind: string;
  /** A hard cap: `approve` is refused while one stands. */
  hard: boolean;
  /** One line for the card. */
  message: string;
}

export interface ProjectGateView {
  brief?: ProjectBrief;
  rows: ProjectGateRow[];
  totals: ProjectPlanTotals;
  milestones: ProjectMilestone[];
  gate: ProjectGate;
  /** The number a decision must carry (`gateVersion`); a stale one is refused. */
  version: number;
  allowedVerdicts: ProjectVerdict[];
  violations: ProjectGateViolation[];
  /** Compact or full plan, from `llm.runMode.fusion.project`; `/plan` shows full. */
  detail: PlanDetail;
  expectation: ProjectExpectation;
}

/**
 * The person's decision as a surface sends it: a {@link ProjectDecision}
 * plus, for the milestone gate's `edit` verdict, the person's
 * correction in their own words.
 */
export type ProjectGateDecision = ProjectDecision & { note?: string };

/** What `AgentRuntime.projectDecision` answers. */
export type ProjectDecisionOutcome =
  | { ok: true; view: ProjectGateView }
  | { ok: false; error: { code: string; message: string } };
