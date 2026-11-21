/**
 * The fusion project (issue #39): the brief the person approves, the
 * plan of tasks and the milestones a director works through, kept on the
 * session (`SessionState.project`) so a restart or reopened chat resumes
 * at the same gate. Shared contract: the director tools fold
 * `details.projectUpdate` through {@link applyProjectUpdate}; every
 * surface decides through {@link applyProjectDecision}; the dispatch gate,
 * the prompt digest and the cards read the same shapes. Keep the names.
 *
 * Everything here is pure: no clock (callers pass `now`), no config, no
 * I/O. Two rules hold by construction:
 *  - the model can never approve: {@link ProjectUpdate} carries no status
 *    and every model update leaves the brief or plan it touches a draft;
 *  - every change the person may approve against bumps the number they
 *    approve with ({@link gateVersion}), so a stale card is refused.
 *
 * Member refs (`worker`, `reviewer`) are `"<providerId>:<model>"`
 * strings, as written in `llm.runMode.fusion.team`.
 */

import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { PROJECT_LIMITS } from "./project-limits.js";
export { PROJECT_LIMITS } from "./project-limits.js";
import { CRITERION_ID_PATTERN, normalizeCriterionId } from "./project-criterion-id.js";
import type { ContractCheck } from "../tools/fusion/contract.js";
import { parsePlanRowChecks } from "../tools/fusion/contract-check-spec.js";
import { evaluatePlanChecks, planCheckReviewBlocks, type PlanCheckOptions, type PlanCheckResult, type PlanDecision } from "../tools/fusion/plan-checks.js";
import type { SessionState } from "./session-state.js";

export interface ProjectGameBrief {
  rules: string;
  loop: string;
  difficulty: string;
  style: string;
}

/**
 * One success criterion (issue #40). `id` names it to contract checks
 * (`criteria: [ids]`), the judge's facts and the milestone card: unique
 * in the brief, at most {@link PROJECT_LIMITS}.criterionId characters of
 * `[a-z0-9-]`. A criterion written as plain text (an older store, or a
 * draft that gives none) gets the first free `c<n>`, `n` its position
 * from 1, so an all-text list reads back as `c1..cN`.
 */
export interface ProjectCriterion {
  id: string;
  text: string;
}

/** What a draft or the person's edit may give for a criterion: text alone, or text with its id. */
export type ProjectCriterionInput = string | ProjectCriterion;

/** A criterion id's shape ({@link ProjectCriterion}). */
export { CRITERION_ID_PATTERN, normalizeCriterionId } from "./project-criterion-id.js";

/**
 * What the project delivers (schema v2, issue #113). Absent means
 * `code`. Stored and hashed with the brief only: nothing reads it yet
 * (`brief.game` keeps working as before; #113 folds it in).
 */
export type ProjectDeliverable = "code" | "document" | "spreadsheet" | "research" | "files" | "game";
export const PROJECT_DELIVERABLES: readonly ProjectDeliverable[] = ["code", "document", "spreadsheet", "research", "files", "game"];

/**
 * A project decision (schema v2, issue #112): how something must be done
 * ("SQLite, not Postgres"). Author content, approved with the brief and
 * covered by its hash; ids follow {@link CRITERION_ID_PATTERN}. Its
 * status is the person's call and lives in the record
 * ({@link ProjectState.decisionStatus}), never in `project.json`.
 */
export interface ProjectBriefDecision {
  id: string;
  text: string;
}

/** A decision's status (issue #112); absent from {@link ProjectState.decisionStatus} means `active`. */
export type ProjectDecisionStatus = "active" | "informational" | "deferred" | "retired";
export const PROJECT_DECISION_STATUSES: readonly ProjectDecisionStatus[] = ["active", "informational", "deferred", "retired"];

/** Who proposed a backlog item (issue #111). */
export type ProjectBacklogSource = "person" | "director" | "worker" | "reviewer";
export const PROJECT_BACKLOG_SOURCES: readonly ProjectBacklogSource[] = ["person", "director", "worker", "reviewer"];

/**
 * A backlog item (schema v2, issue #111): work not ready for the plan
 * yet, optionally with a `condition` (a seed). Proposed items are author
 * content in `project.json`, outside every gate's hash: editing the
 * backlog reopens no gate. Whether the person promoted or dropped one is
 * the record's ({@link ProjectState.backlogStates}). `source` is a label
 * as written, not a proof of who wrote it.
 */
export interface ProjectBacklogItem {
  id: string;
  title: string;
  note?: string;
  /** A seed's activation condition, free text. */
  condition?: string;
  source: ProjectBacklogSource;
  createdAt: number;
  /** The milestone or task it came from. */
  origin?: { milestoneId?: string; taskId?: string };
}

/** The person's call on a backlog item; absent from {@link ProjectState.backlogStates} means open. */
export type ProjectBacklogState = "promoted" | "dropped";

export interface ProjectBrief {
  /** 1 on the first draft; +1 on every edit by the model or the person. */
  version: number;
  what: string;
  users: string;
  how: string;
  game?: ProjectGameBrief;
  /** Schema v2 (issue #113); absent: code. */
  deliverable?: ProjectDeliverable;
  /** Schema v2 (issue #112), at most {@link PROJECT_LIMITS}.decisions. */
  decisions?: ProjectBriefDecision[];
  successCriteria: ProjectCriterion[];
  status: "draft" | "approved";
  /** Epoch ms of the person's approval; absent on a draft. */
  approvedAt?: number;
  /** The draft was written after untrusted content entered the turn; the card warns. */
  draftedAfterUntrusted: boolean;
}

export type MilestoneKind = "base" | "ui" | "logic" | "polish" | "other";
export const MILESTONE_KINDS: readonly MilestoneKind[] = ["base", "ui", "logic", "polish", "other"];

/**
 * `planned` → (plan or previous milestone approved) `approved` → (a run
 * started) `in_progress` → (director's report) `done` | `failed` →
 * (person approves a done result) `reviewed`. Approving a failed result
 * sends it back to `approved` for another run.
 */
export type MilestoneState = "planned" | "approved" | "in_progress" | "done" | "failed" | "reviewed";
export const MILESTONE_STATES: readonly MilestoneState[] = ["planned", "approved", "in_progress", "done", "failed", "reviewed"];

/** The person's correction of a milestone's result (the milestone gate's `edit`). */
export interface MilestoneCorrection {
  note: string;
  /** Epoch ms of the decision. */
  at: number;
}

/**
 * A picture of a milestone's result (issue #40): a screenshot a verify
 * run of that milestone stored under `<stateDir>/fusion-runs/<runId>/shots/`
 * ({@link validateMilestoneAttachments}). Surfaces show the caption and
 * the path; a renderer reads the file through its own safe file read.
 */
export interface ProjectMilestoneAttachment {
  /** Absolute, normalized; directly inside a recorded run's shots folder. */
  path: string;
  caption: string;
  /** Ids of the brief's success criteria the picture shows. */
  criteria?: string[];
}

export type CriterionFactState = "passed" | "failed" | "unverified";

/** A required task the milestone cannot close on yet (issue #98). */
export interface ProjectReviewBlock {
  taskId: string;
  /** One line: the open needs-changes, the missing verdict and why, or that it was never reviewed. */
  reason: string;
}

/**
 * Where one success criterion stands after a milestone's runs: from its
 * contract checks and the vision judgement (issue #40). Written by the
 * runtime: `project.milestone` reads them from the milestone's runs and
 * carries them on its done report (`criteriaFacts`), never the model's
 * arguments.
 */
export interface ProjectCriterionFact {
  id: string;
  state: CriterionFactState;
  /** One line, e.g. the failing check or why it could not be judged. */
  why?: string;
  /**
   * Issue #110: `passed`, but only checks with a lint warning support it
   * (they may also pass on the wrong thing): "verified with
   * reservations". One line, what those checks prove too little about.
   * Never on another state; no verdict reads it.
   */
  reservation?: string;
}

export const CRITERION_FACT_STATES: readonly CriterionFactState[] = ["passed", "failed", "unverified"];

export interface ProjectMilestone {
  id: string;
  title: string;
  kind: MilestoneKind;
  state: MilestoneState;
  /** Fusion run ids (`fusion-runs` checkpoints) that worked on it, oldest first. */
  runIds: string[];
  /** The director's report of the result. */
  summary?: string;
  /** The person's corrections at its gate, oldest first ({@link PROJECT_LIMITS}.corrections newest kept). */
  corrections?: MilestoneCorrection[];
  /** Pictures of the reported result ({@link PROJECT_LIMITS}.attachments); a new report replaces them. */
  attachments?: ProjectMilestoneAttachment[];
  /** Per success criterion, the facts of its runs (the runtime's; one per id, brief order). */
  criteriaFacts?: ProjectCriterionFact[];
  /**
   * Required tasks (the approved plan's rows for this milestone) without
   * a current reviewer accept at its last done report (issue #98), the
   * runtime's, with why. While any is listed, approving the result is
   * refused (`review-open`): the milestone stays open.
   */
  reviewBlocks?: ProjectReviewBlock[];
  /**
   * The person approved this milestone over open review blocks
   * (`approveOverReview`, issue #98): their note, when, and the blocks it
   * stood over.
   */
  reviewOverride?: { note: string; at: number; blocks: ProjectReviewBlock[] };
  /**
   * How many times `project.milestone failed` was held back for a
   * correction round (issue #100); at most two, after which a failed
   * report is accepted.
   */
  failedRefusals?: number;
  /**
   * Evidence of earlier work under this id (issue #77), oldest first
   * ({@link PROJECT_LIMITS}.history newest kept): a re-plan that changes
   * the milestone's work ({@link milestoneWorkChanged}) moves its state's
   * evidence here and starts it over as `planned`.
   */
  history?: ProjectMilestoneRevision[];
  updatedAt: number;
}

/** A task as the work check reads it: its id and title in the plan. */
export interface ProjectMilestoneTask {
  taskId: string;
  title: string;
}

/**
 * What a milestone held for work a re-plan, or a changed criterion,
 * replaced (issue #77): a lean, read-only record of what the work was
 * (title, kind, task titles) and where it stood (state, runs, the report
 * capped at {@link PROJECT_LIMITS}.shortText, criteria facts). The
 * person's correction notes and the pictures are not copied, only
 * counted: the runs' checkpoints keep the screenshots. Nothing acts on it.
 */
export type RevisionCause = "plan" | "brief" | "brief-removed";

export interface ProjectMilestoneRevision {
  title: string;
  kind: MilestoneKind;
  state: MilestoneState;
  /** Task titles of the work, by task id. */
  tasks: string[];
  runIds: string[];
  summary?: string;
  criteriaFacts?: ProjectCriterionFact[];
  correctionCount?: number;
  attachmentCount?: number;
  /**
   * The brief's criteria its facts and pictures cite, with their text at
   * the time (issue #80): a fact stays tied to the requirement it
   * measured even after its id is removed or reused.
   */
  criteria?: ProjectCriterion[];
  /**
   * Ids of retired criteria whose text was never recorded (issue #83):
   * evidence a project saved before issue #80 kept for a criterion
   * already gone from its approved brief. Their text is unknown, so none
   * is written; the id alone may since name another requirement.
   */
  unknownCriteria?: string[];
  /**
   * `plan`: a re-plan changed the work; `brief`: the text of a criterion
   * its evidence cites changed; `brief-removed` (issue #80): cited
   * criteria were removed, and this entry holds only their facts and the
   * count of their pictures; the milestone kept its state and the rest.
   */
  cause: RevisionCause;
  /** Epoch ms of the update that replaced this work. */
  supersededAt: number;
}

export type EstimateBasis = "measured" | "preset";

export interface AssignmentRow {
  taskId: string;
  title: string;
  milestoneId: string;
  /** Member ref of the worker. */
  worker: string;
  /** Member ref of the reviewer; null: no per-task review. */
  reviewer: string | null;
  /**
   * The person picked this reviewer (or "no review") at the plan gate;
   * the cheaper and quality variants keep it. Never from the director.
   */
  reviewerByPerson?: true;
  /** Why this worker, in a few words ("insufficient data, chosen from the preset"). */
  reason: string;
  basis: EstimateBasis;
  /** Outcome rows the estimate stands on (0 for a preset). */
  samples: number;
  estCostUsd: number | null;
  estMs: number | null;
  /** The worker runs on a local server: `estCostUsd` is 0, shown as "$0.00 (local)" (issue #54). */
  local?: true;
  /** Schema v2 (issue #112): ids of the brief's decisions this task honours. */
  decisions?: string[];
  /** Same spec language as fusion.delegate; task ownership is implicit in this row. */
  checks?: ContractCheck[];
}

export interface ProjectPlanTotals {
  /** Sum of the rows' known costs; null when no row has one. */
  costUsd: number | null;
  /** Sum of the rows' known times; null when no row has one. `estimatePlan` gives the wave-aware figure. */
  ms: number | null;
  /** Rows whose cost is unknown. */
  unknownCostRows: number;
}

export type PlanDetail = "compact" | "full";

export interface ProjectPlan {
  /** Runtime-derived static analysis, recomputed when loading or approving. Record only. */
  checkResults?: PlanCheckResult[];
  rows: AssignmentRow[];
  totals: ProjectPlanTotals;
  detail: PlanDetail;
  status: "draft" | "approved" | "cancelled";
  /**
   * 1 on the first draft; +1 on every edit, re-plan, person's edit or
   * variant, and on every milestone report (the milestone gate approves
   * against it too).
   */
  version: number;
  approvedAt?: number;
  /**
   * The director drafted this plan after outside content entered the
   * chat (the approval gate's taint), like the brief's flag. Every
   * surface shows the warning at the plan gate.
   */
  draftedAfterUntrusted: boolean;
  /**
   * Set when the person approved a plan drafted after outside content,
   * from a view that showed that warning. Only then does the approval
   * stand in for the fan-out prompt (`planCoversFanout`).
   */
  approvedWithUntrustedWarning?: true;
  /**
   * Milestones (ids) this draft started over on new work, dropping a
   * verdict or runs into their `history` (issue #77); the plan gate
   * names them. Cleared when the plan is approved.
   */
  verdictResets?: string[];
  /**
   * Milestones (ids) that kept their state but lost criteria evidence at
   * a brief approval (issue #83): a project saved before issue #80
   * approved without a baseline, or a reviewed or done milestone whose
   * only facts and pictures were retired. The plan gate names each
   * ("evidence retired: <title>"); kept across drafts, cleared on approval.
   */
  evidenceRetired?: string[];
}

export type ProjectGate =
  | { kind: "none" }
  | { kind: "brief" }
  | { kind: "plan" }
  | { kind: "milestone"; id: string };

export interface ProjectState {
  brief?: ProjectBrief;
  plan?: ProjectPlan;
  /** In plan order; the order milestones are approved and run in. */
  milestones: ProjectMilestone[];
  /** What waits on the person; `none` while the director works (or nothing is open). */
  gate: ProjectGate;
  /**
   * The success criteria of the last brief the person approved (issue
   * #80): a brief's approval judges its criteria against these, so
   * drafts in between never reset anything. Absent before the first
   * approval; an older store with an approved brief reads its criteria.
   */
  approvedCriteria?: ProjectCriterion[];
  /**
   * The decisions of the last brief the person approved (issue #112),
   * like {@link approvedCriteria}: what the plan must cite and what a
   * brief approval compares a changed decision against. Record only;
   * absent before the first approval with decisions (an older store
   * with an approved brief reads its decisions).
   */
  approvedDecisions?: ProjectBriefDecision[];
  /**
   * How many times the person approved this project's brief (issue #87):
   * 1 means the brief is the one first approved, with no later approval.
   * Absent in a store from before the count (unknown). A run fact with
   * no recorded criterion text stands only while this is exactly 1.
   */
  briefApprovals?: number;
  /** Epoch ms the person cancelled the project; a new brief starts over. */
  cancelledAt?: number;
  /**
   * The highest brief/plan version a cancelled project issued. A new
   * project's versions start above it, so a card shown for the old one
   * can never approve a brief or plan the person has not seen.
   */
  versionFloor?: number;
  /**
   * Gates whose content changed since the person decided them, outside
   * Atomic Agent (issue #109): `brief`, `plan`, `milestone:<id>`. Set only
   * when the project is read from its folder store (`resolveProject`),
   * never stored; an automatic approval stops at such a gate.
   */
  changedOutside?: string[];
  /**
   * Schema v2 (issue #111): proposed work outside the plan, at most
   * {@link PROJECT_LIMITS}.backlog. Author content, covered by no gate's hash.
   */
  backlog?: ProjectBacklogItem[];
  /**
   * The person's status per brief decision id (issue #112); a decision
   * not listed is `active`. Record only: never written to or read from
   * `project.json`.
   */
  decisionStatus?: Record<string, ProjectDecisionStatus>;
  /** The person's call per backlog item id (issue #111); one not listed is open. Record only. */
  backlogStates?: Record<string, ProjectBacklogState>;
}

/**
 * `metadata.projectGates`: whether this session runs the project flow
 * (issue #39), stamped by the runtime from the session's first surface
 * and never changed after, so the stable prefix stays put.
 */
export const PROJECT_GATES_METADATA_KEY = "projectGates";

/** The session's stamped capability; undefined before its first turn. */
export function readProjectGatesCapability(metadata: Record<string, unknown> | undefined): boolean | undefined {
  const value = metadata?.[PROJECT_GATES_METADATA_KEY];
  return typeof value === "boolean" ? value : undefined;
}

// ---------------------------------------------------------------- updates

/** The brief fields the director writes (`project.brief`). */
export interface ProjectBriefDraft {
  what: string;
  users: string;
  how: string;
  game?: ProjectGameBrief;
  /** Schema v2 (issue #113). */
  deliverable?: ProjectDeliverable;
  /** Schema v2 (issue #112): ids as {@link CRITERION_ID_PATTERN}, unique. */
  decisions?: ReadonlyArray<ProjectBriefDecision>;
  /** Ids are given or assigned ({@link ProjectCriterion}). */
  successCriteria: ReadonlyArray<ProjectCriterionInput>;
}

/**
 * The last approved brief's decisions (issue #112): recorded, or an
 * older store's approved brief's own; empty without an approval.
 */
export function approvedDecisionsOf(project: Pick<ProjectState, "approvedDecisions" | "brief">): ProjectBriefDecision[] {
  return project.approvedDecisions ?? (project.brief?.status === "approved" ? project.brief.decisions ?? [] : []);
}

/** A decision's status: the person's call in the record, `active` when none (issue #112). */
export function decisionStatusOf(project: Pick<ProjectState, "decisionStatus">, id: string): ProjectDecisionStatus {
  return project.decisionStatus?.[id] ?? "active";
}

/** The approved decisions with their status, in brief order: what the plan check reads (issue #112). */
export function planDecisionsOf(project: Pick<ProjectState, "approvedDecisions" | "brief" | "decisionStatus">): PlanDecision[] {
  return approvedDecisionsOf(project).map((d) => ({ id: d.id, text: d.text, status: decisionStatusOf(project, d.id) }));
}

/** The approved decisions still `active` (issue #112): what workers and reviewers are told. */
export function activeDecisionsOf(project: Pick<ProjectState, "approvedDecisions" | "brief" | "decisionStatus">): ProjectBriefDecision[] {
  return approvedDecisionsOf(project).filter((d) => decisionStatusOf(project, d.id) === "active");
}

/** A brief's criteria by id, in brief order; empty without a brief. */
export function criteriaById(brief: Pick<ProjectBrief, "successCriteria"> | null | undefined): Map<string, ProjectCriterion> {
  return new Map((brief?.successCriteria ?? []).map((c) => [c.id, c]));
}

/**
 * What a director tool (or the runtime, for `milestone_run`) folds into
 * the project. None of them carries a status: approval is the person's.
 *  - `brief`: a new or edited brief draft; gate `brief`.
 *  - `plan`: milestones and enriched rows (estimates already attached by
 *    `estimatePlan`); totals are recomputed here; gate `plan`.
 *  - `milestone`: the director's report of an approved milestone's
 *    result; gate `milestone:<id>`.
 *  - `milestone_run`: the dispatch started a run of an approved milestone.
 */
export type ProjectUpdate =
  | { kind: "brief"; brief: ProjectBriefDraft; draftedAfterUntrusted: boolean }
  | {
      kind: "plan";
      milestones: ReadonlyArray<{ id: string; title: string; kind: MilestoneKind }>;
      rows: readonly AssignmentRow[];
      detail: PlanDetail;
      /** Drafted after outside content (the tool reads the approval gate's taint). */
      draftedAfterUntrusted?: boolean;
    }
  | {
      kind: "milestone";
      id: string;
      state: "done" | "failed";
      summary: string;
      /** Checked by {@link validateMilestoneAttachments} when folded. */
      attachments?: ReadonlyArray<ProjectMilestoneAttachment>;
      /**
       * The milestone's criteria facts, from its runs (issue #40): set by
       * the runtime's `project.milestone` (its arguments cannot carry
       * them), cleaned when folded; a report without them clears them.
       */
      criteriaFacts?: ReadonlyArray<ProjectCriterionFact>;
      /** The runtime's review blocks (issue #98): set by `project.milestone`, cleaned when folded; absent clears them. */
      reviewBlocks?: ReadonlyArray<ProjectReviewBlock>;
      /**
       * Set by `project.milestone` (never the model's arguments) when it
       * holds a failed report back for a correction round (issue #100):
       * nothing is reported, the milestone stays in progress, and only its
       * `failedRefusals` count goes up.
       */
      holdForCorrection?: true;
    }
  | { kind: "milestone_run"; id: string; runId: string };

export interface ProjectUpdateOptions {
  /**
   * The state dir a report's attachments must lie under
   * ({@link validateMilestoneAttachments}); absent: a report with
   * attachments is refused.
   */
  stateDir?: string;
}

export type ProjectUpdateErrorCode =
  | "invalid"
  | "brief-not-approved"
  | "plan-not-approved"
  | "unknown-milestone"
  | "milestone-not-approved"
  | "cancelled"
  /** A milestone result waits for the person: no brief or plan re-draft until they decide (issue #74). */
  | "awaiting-person"
  /** A done report with no run since the milestone's approval or its last failed report (issue #74). */
  | "milestone-not-run";

export interface ProjectUpdateError {
  code: ProjectUpdateErrorCode;
  /** One sentence the model can act on. */
  message: string;
}

export type ProjectUpdateResult =
  | { ok: true; project: ProjectState }
  | { ok: false; error: ProjectUpdateError };

// -------------------------------------------------------------- decisions

/**
 * `approveOverReview` (issue #98): the person approves a milestone result
 * over open review blocks (an unreachable reviewer, one switched off) with
 * a note. Offered only while the gate's milestone has blocks, and never
 * taken by an automatic path (`--auto-approve-project`, `run --approve`).
 */
export type ProjectVerdict = "approve" | "edit" | "cheaper" | "quality" | "cancel" | "approveOverReview";

/** The person's changes with an `edit` verdict. */
export interface ProjectEdits {
  /** Brief gate: the fields to replace. */
  brief?: Partial<ProjectBriefDraft>;
  /** Plan gate: per task, a new worker and/or reviewer (null: no review). */
  rows?: ReadonlyArray<{ taskId: string; worker?: string; reviewer?: string | null }>;
  /**
   * Milestone gate: what is wrong with the result. The milestone goes
   * back to `approved` for another run, the note recorded on it
   * (`corrections`) and shown to the director.
   */
  note?: string;
}

export interface ProjectDecision {
  /** The gate the person saw; must be the current one. */
  gate: ProjectGate;
  /** {@link gateVersion} the person saw; any other is stale. */
  version: number;
  verdict: ProjectVerdict;
  edits?: ProjectEdits;
}

export interface ProjectDecisionOptions {
  now: number;
  /** Runtime policy, never taken from project.json. */
  planChecks?: PlanCheckOptions;
  /**
   * Hard-cap violations of the plan as it stands (`estimatePlan`, from
   * the caller's live budget): non-empty refuses `approve` at the plan
   * and milestone gates.
   */
  hardViolations?: readonly string[];
  /**
   * Re-estimates rows after an `edit` and builds the `cheaper` /
   * `quality` variant (`project-estimate.ts`). Must be pure. Absent: an
   * edited row loses its estimate, and `cheaper`/`quality` are refused.
   */
  replan?: (rows: readonly AssignmentRow[], verdict: "edit" | "cheaper" | "quality") => AssignmentRow[];
}

export type ProjectDecisionError =
  | { code: "no-project"; message: string }
  | { code: "wrong-gate"; message: string; current: ProjectGate }
  | { code: "stale-version"; message: string; current: number | null }
  | { code: "verdict-not-allowed"; message: string; allowed: ProjectVerdict[] }
  | { code: "over-cap"; message: string; violations: string[] }
  | { code: "review-open"; message: string; blocks: ProjectReviewBlock[] }
  | { code: "needs-estimates"; message: string }
  | { code: "invalid"; message: string };

export type ProjectDecisionResult =
  | { ok: true; project: ProjectState }
  | { ok: false; error: ProjectDecisionError };

// ---------------------------------------------------------------- helpers

function clip(raw: string, max: number): string {
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** Multi-line text keeps its line breaks; runs of blank lines fold to one. */
function clipText(raw: string, max: number): string {
  const text = raw.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isVersion = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1;
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const isAmount = (v: unknown): v is number | null => v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0);

function sameGate(a: ProjectGate, b: ProjectGate): boolean {
  return a.kind === b.kind && (a.kind !== "milestone" || a.id === (b as { id: string }).id);
}

/** The number a decision at the current gate must carry; null when nothing can be decided. */
export function gateVersion(project: ProjectState | undefined): number | null {
  if (project === undefined) return null;
  switch (project.gate.kind) {
    case "brief":
      return project.brief?.version ?? null;
    case "plan":
    case "milestone":
      return project.plan?.version ?? null;
    case "none":
      return project.plan?.version ?? project.brief?.version ?? null;
  }
}

/** The verdicts a gate accepts (the cards draw these buttons). */
export function allowedProjectVerdicts(gate: ProjectGate, project?: ProjectState): ProjectVerdict[] {
  switch (gate.kind) {
    case "brief":
      return ["approve", "edit", "cancel"];
    case "plan":
      return ["approve", "edit", "cheaper", "quality", "cancel"];
    case "milestone": {
      const blocked = (project?.milestones.find((m) => m.id === gate.id)?.reviewBlocks ?? []).length > 0;
      return blocked ? ["approve", "edit", "approveOverReview", "cancel"] : ["approve", "edit", "cancel"];
    }
    case "none":
      return ["cancel"];
  }
}

/** Row totals by plain sums ({@link ProjectPlanTotals}). */
export function planTotals(rows: readonly AssignmentRow[]): ProjectPlanTotals {
  let cost: number | null = null;
  let ms: number | null = null;
  let unknown = 0;
  for (const row of rows) {
    if (row.estCostUsd === null) unknown += 1;
    else cost = (cost ?? 0) + row.estCostUsd;
    if (row.estMs !== null) ms = (ms ?? 0) + row.estMs;
  }
  return { costUsd: cost === null ? null : Math.round(cost * 1e6) / 1e6, ms, unknownCostRows: unknown };
}

export type ProjectExpectation =
  | { kind: "draft_brief" }
  | { kind: "draft_plan" }
  | { kind: "run_milestone"; id: string }
  | { kind: "await_person"; gate: Exclude<ProjectGate, { kind: "none" }> }
  | { kind: "complete" }
  | { kind: "cancelled" };

/**
 * What happens next: the person decides at an open gate, else the
 * director drafts the brief, drafts the plan once the brief is approved,
 * or runs the approved (or in-progress) milestone.
 */
export function projectExpectation(project: ProjectState | undefined): ProjectExpectation {
  if (project === undefined || project.brief === undefined) return { kind: "draft_brief" };
  if (project.cancelledAt !== undefined) return { kind: "cancelled" };
  if (project.gate.kind !== "none") return { kind: "await_person", gate: project.gate };
  if (project.brief.status !== "approved") return { kind: "draft_brief" };
  if (project.plan === undefined || project.plan.status !== "approved") return { kind: "draft_plan" };
  const open = project.milestones.find((m) => m.state === "approved" || m.state === "in_progress");
  if (open !== undefined) return { kind: "run_milestone", id: open.id };
  return project.milestones.every((m) => m.state === "reviewed") ? { kind: "complete" } : { kind: "draft_plan" };
}

// ---------------------------------------------------------------- session

export function readProject(state: Pick<SessionState, "project">): ProjectState | undefined {
  return state.project;
}

/** Store the project on the session; undefined removes it. Same object back when nothing changes. */
export function withProject(state: SessionState, project: ProjectState | undefined): SessionState {
  if (project === undefined) {
    if (state.project === undefined) return state;
    const rest: SessionState = { ...state };
    delete rest.project;
    return rest;
  }
  if (state.project === project) return state;
  return { ...state, project };
}

// ------------------------------------------------------------- validation

function invalid(message: string): { ok: false; error: ProjectUpdateError } {
  return { ok: false, error: { code: "invalid", message } };
}

function readGame(raw: unknown): ProjectGameBrief | undefined | null {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) return null;
  const fields = ["rules", "loop", "difficulty", "style"] as const;
  const out: Partial<ProjectGameBrief> = {};
  for (const f of fields) {
    if (typeof raw[f] !== "string") return null;
    out[f] = clip(raw[f] as string, PROJECT_LIMITS.shortText);
  }
  return out as ProjectGameBrief;
}

/**
 * Criteria cleaned, ids given or assigned ({@link ProjectCriterion}).
 * `strict` (a draft): over the cap, a malformed entry, a bad or repeated
 * id is the error message. `lenient` (a stored brief): the list is cut,
 * a bad or repeated id gets a fresh `c<n>`, a malformed entry is null
 * (the project is dropped, as any malformed store). Text that clips to
 * nothing is skipped. Plain text matching one of `previous` (the brief
 * being revised) keeps that criterion's id.
 */
function cleanCriteria(
  raw: unknown,
  mode: "strict" | "lenient",
  previous: readonly ProjectCriterion[] = [],
): ProjectCriterion[] | string | null {
  if (!Array.isArray(raw)) return mode === "strict" ? "brief.successCriteria must be a list" : null;
  if (mode === "strict" && raw.length > PROJECT_LIMITS.successCriteria) {
    return `brief.successCriteria: at most ${PROJECT_LIMITS.successCriteria} criteria`;
  }
  const items: Array<{ text: string; id: string | null }> = [];
  const taken = new Set<string>();
  for (const [i, item] of raw.slice(0, PROJECT_LIMITS.successCriteria).entries()) {
    let text: string;
    let id: string | null = null;
    if (typeof item === "string") text = item;
    else if (isObject(item) && typeof item.text === "string") {
      text = item.text;
      id = normalizeCriterionId(item.id);
      if (id === null || taken.has(id)) {
        if (mode === "strict") {
          return id === null
            ? `brief.successCriteria ${i + 1}: id must be 1..${PROJECT_LIMITS.criterionId} characters of a-z, 0-9 and -`
            : `brief.successCriteria: id ${id} is used twice`;
        }
        id = null;
      }
    } else {
      return mode === "strict" ? `brief.successCriteria ${i + 1} must be text or { id, text }` : null;
    }
    const clipped = clip(text, PROJECT_LIMITS.shortText);
    if (clipped.length === 0) continue;
    if (id !== null) taken.add(id);
    items.push({ text: clipped, id });
  }
  // Text alone: the id it had in the brief being revised, else the first free c<n>.
  for (const item of items) {
    if (item.id !== null) continue;
    const kept = previous.find((c) => c.text === item.text && !taken.has(c.id));
    if (kept !== undefined) {
      item.id = kept.id;
      taken.add(kept.id);
    }
  }
  return items.map((item, i) => {
    if (item.id !== null) return { id: item.id, text: item.text };
    let n = i + 1;
    while (taken.has(`c${n}`)) n += 1;
    taken.add(`c${n}`);
    return { id: `c${n}`, text: item.text };
  });
}

/**
 * A brief's decisions (schema v2). `strict` (a draft): a malformed list,
 * entry, id or repeated id, or more than the cap, is the error message.
 * `lenient` (stored): malformed entries are dropped, the list cut.
 * Undefined when absent (or, lenient, nothing usable).
 */
function cleanDecisions(raw: unknown, mode: "strict" | "lenient"): ProjectBriefDecision[] | undefined | string {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) return mode === "strict" ? "brief.decisions must be a list of { id, text }" : undefined;
  if (mode === "strict" && raw.length > PROJECT_LIMITS.decisions) return `brief.decisions: at most ${PROJECT_LIMITS.decisions}`;
  const out: ProjectBriefDecision[] = [];
  for (const [i, d] of raw.entries()) {
    if (out.length >= PROJECT_LIMITS.decisions) break;
    const id = isObject(d) ? normalizeCriterionId(d.id) : null;
    const text = isObject(d) && typeof d.text === "string" ? clip(d.text, PROJECT_LIMITS.shortText) : "";
    if (id === null || text.length === 0 || out.some((x) => x.id === id)) {
      if (mode === "lenient") continue;
      if (id !== null && out.some((x) => x.id === id)) return `brief.decisions: id ${id} is used twice`;
      return id === null
        ? `brief.decisions ${i + 1}: id must be 1..${PROJECT_LIMITS.criterionId} characters of a-z, 0-9 and -`
        : `brief.decisions ${i + 1} needs a text`;
    }
    out.push({ id, text });
  }
  return out.length === 0 && mode === "lenient" ? undefined : out;
}

const DELIVERABLES: ReadonlySet<string> = new Set(PROJECT_DELIVERABLES);

/** A list of decision ids on a plan row: unique, each a criterion-shaped id; null when malformed. */
function cleanRowDecisions(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > PROJECT_LIMITS.decisions) return null;
  const out: string[] = [];
  for (const item of raw) {
    const id = normalizeCriterionId(item);
    if (id === null || out.includes(id)) return null;
    out.push(id);
  }
  return out;
}

/** A stored backlog read leniently: malformed or repeated items dropped, the list cut. */
function readBacklog(raw: unknown): ProjectBacklogItem[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ProjectBacklogItem[] = [];
  for (const b of raw) {
    if (out.length >= PROJECT_LIMITS.backlog) break;
    if (!isObject(b)) continue;
    const id = normalizeCriterionId(b.id);
    const title = typeof b.title === "string" ? clip(b.title, PROJECT_LIMITS.title) : "";
    if (id === null || title.length === 0 || out.some((x) => x.id === id)) continue;
    if (typeof b.source !== "string" || !(PROJECT_BACKLOG_SOURCES as readonly string[]).includes(b.source) || !isTime(b.createdAt)) continue;
    const note = typeof b.note === "string" ? clip(b.note, PROJECT_LIMITS.shortText) : "";
    const condition = typeof b.condition === "string" ? clip(b.condition, PROJECT_LIMITS.shortText) : "";
    const milestoneId = isObject(b.origin) ? cleanId(b.origin.milestoneId) : null;
    const taskId = isObject(b.origin) ? cleanId(b.origin.taskId) : null;
    out.push({
      id,
      title,
      ...(note.length === 0 ? {} : { note }),
      ...(condition.length === 0 ? {} : { condition }),
      source: b.source as ProjectBacklogSource,
      createdAt: b.createdAt,
      ...(milestoneId === null && taskId === null ? {} : { origin: { ...(milestoneId === null ? {} : { milestoneId }), ...(taskId === null ? {} : { taskId }) } }),
    });
  }
  return out.length === 0 ? undefined : out;
}

/** A stored id → value map read leniently: keys criterion-shaped, values in `allowed`. */
function readStatusMap<T extends string>(raw: unknown, allowed: readonly T[]): Record<string, T> | undefined {
  if (!isObject(raw)) return undefined;
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(raw)) {
    const id = normalizeCriterionId(key);
    if (id === null || id !== key || typeof value !== "string" || !(allowed as readonly string[]).includes(value)) continue;
    out[id] = value as T;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** The backlog and the person's calls on it and on the decisions: carried by every update. */
function personCalls(project: ProjectState | undefined, decisionsToo: boolean): Pick<ProjectState, "backlog" | "decisionStatus" | "backlogStates"> {
  return {
    ...(project?.backlog === undefined ? {} : { backlog: project.backlog }),
    ...(project?.backlogStates === undefined ? {} : { backlogStates: project.backlogStates }),
    ...(!decisionsToo || project?.decisionStatus === undefined ? {} : { decisionStatus: project.decisionStatus }),
  };
}

/** A brief's fields as stored: criteria carry their ids. */
type CleanBriefDraft = Omit<ProjectBriefDraft, "successCriteria" | "decisions"> & { successCriteria: ProjectCriterion[]; decisions?: ProjectBriefDecision[] };

/** A draft's fields cleaned, or an error message; `previous` is the brief being revised. */
function cleanBriefDraft(draft: ProjectBriefDraft, previous: readonly ProjectCriterion[] = []): CleanBriefDraft | string {
  for (const f of ["what", "users", "how"] as const) {
    if (typeof draft[f] !== "string") return `brief.${f} must be text`;
  }
  const what = clipText(draft.what, PROJECT_LIMITS.text);
  if (what.length === 0) return "brief.what must say what is being built";
  const game = readGame(draft.game);
  if (game === null) return "brief.game must be { rules, loop, difficulty, style } as text";
  const criteria = cleanCriteria(draft.successCriteria, "strict", previous);
  if (criteria === null || typeof criteria === "string") {
    return criteria ?? `brief.successCriteria must be a list of at most ${PROJECT_LIMITS.successCriteria} short sentences`;
  }
  if (criteria.length === 0) return "brief.successCriteria needs at least one criterion";
  if (draft.deliverable !== undefined && !DELIVERABLES.has(draft.deliverable as string)) {
    return `brief.deliverable must be one of ${PROJECT_DELIVERABLES.join("|")}`;
  }
  const decisions = cleanDecisions(draft.decisions, "strict");
  if (typeof decisions === "string") return decisions;
  return {
    what,
    users: clipText(draft.users, PROJECT_LIMITS.text),
    how: clipText(draft.how, PROJECT_LIMITS.text),
    ...(game === undefined ? {} : { game }),
    ...(draft.deliverable === undefined ? {} : { deliverable: draft.deliverable }),
    ...(decisions === undefined || decisions.length === 0 ? {} : { decisions }),
    successCriteria: criteria,
  };
}

function cleanId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  return id.length === 0 || id.length > PROJECT_LIMITS.id || /\s/.test(id) ? null : id;
}

function cleanRef(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const ref = raw.trim();
  return ref.length === 0 || ref.length > PROJECT_LIMITS.memberRef || !ref.includes(":") ? null : ref;
}

/** One row read back strictly (shape) and leniently (text length); null when unusable. */
function readRow(raw: unknown, milestoneIds: ReadonlySet<string>): AssignmentRow | null {
  if (!isObject(raw)) return null;
  const taskId = cleanId(raw.taskId);
  const milestoneId = cleanId(raw.milestoneId);
  const worker = cleanRef(raw.worker);
  const reviewer = raw.reviewer === null ? null : cleanRef(raw.reviewer);
  if (taskId === null || milestoneId === null || !milestoneIds.has(milestoneId) || worker === null) return null;
  if (raw.reviewer !== null && reviewer === null) return null;
  if (typeof raw.title !== "string" || typeof raw.reason !== "string") return null;
  if (raw.basis !== "measured" && raw.basis !== "preset") return null;
  if (!isCount(raw.samples) || !isAmount(raw.estCostUsd) || !isAmount(raw.estMs)) return null;
  const title = clip(raw.title, PROJECT_LIMITS.title);
  if (title.length === 0) return null;
  const decisions = raw.decisions === undefined ? undefined : cleanRowDecisions(raw.decisions);
  if (decisions === null) return null;
  const problems: string[] = [];
  const checks = parsePlanRowChecks(raw.checks, taskId, problems);
  if (problems.length > 0) return null;
  return {
    taskId,
    title,
    milestoneId,
    worker,
    reviewer,
    reason: clip(raw.reason, PROJECT_LIMITS.shortText),
    basis: raw.basis,
    samples: raw.samples,
    estCostUsd: raw.estCostUsd,
    estMs: raw.estMs,
    ...(raw.reviewerByPerson === true ? { reviewerByPerson: true as const } : {}),
    ...(raw.local === true && raw.estCostUsd === 0 ? { local: true as const } : {}),
    ...(decisions === undefined || decisions.length === 0 ? {} : { decisions }),
    ...(raw.checks === undefined ? {} : { checks }),
  };
}

// ------------------------------------------------------------ attachments

/** `<stateDir>/fusion-runs`: the run checkpoints' folder (`FUSION_RUNS_DIR_NAME`). */
export const PROJECT_RUNS_DIR_NAME = "fusion-runs";
/** A run's screenshots folder name, under its run folder. */
export const PROJECT_SHOTS_DIR_NAME = "shots";
/** A run id's shape (`FusionRunStore.isValidRunId`). */
const RUN_ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([".jpg", ".jpeg", ".png"]);

/** `<stateDir>/fusion-runs/<runId>/shots`, where a run's screenshots are stored. */
export function milestoneShotsDir(stateDir: string, runId: string): string {
  return join(resolve(stateDir), PROJECT_RUNS_DIR_NAME, runId, PROJECT_SHOTS_DIR_NAME);
}

/** A list of criterion ids: unique, each of {@link CRITERION_ID_PATTERN}; null when malformed. */
function cleanIdList(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const item of raw.slice(0, PROJECT_LIMITS.successCriteria)) {
    const id = normalizeCriterionId(item);
    if (id === null) return null;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

export type AttachmentCheck =
  | { ok: true; attachments: ProjectMilestoneAttachment[] }
  | { ok: false; problems: string[] };

/**
 * The attachments of a milestone report checked, pure (no file is read):
 * each `path` is absolute, an image (`.jpg`, `.jpeg`, `.png`) and
 * directly inside `<stateDir>/fusion-runs/<runId>/shots/` of a run the
 * milestone recorded (`runIds`); a `caption` is required; `criteria`
 * name the brief's criteria (`criterionIds`, when given). At most
 * {@link PROJECT_LIMITS}.attachments; a repeated path is kept once.
 * Anything else refuses the whole list. A symlink inside the folder is
 * not resolved here: a surface reads the file with its own safe read.
 */
export function validateMilestoneAttachments(input: {
  stateDir: string;
  milestone: Pick<ProjectMilestone, "id" | "runIds">;
  attachments: readonly unknown[];
  criterionIds?: ReadonlySet<string>;
}): AttachmentCheck {
  const problems: string[] = [];
  if (input.attachments.length > PROJECT_LIMITS.attachments) {
    return { ok: false, problems: [`at most ${PROJECT_LIMITS.attachments} attachments`] };
  }
  const roots = input.milestone.runIds.filter((r) => RUN_ID_SHAPE.test(r)).map((r) => milestoneShotsDir(input.stateDir, r));
  const out: ProjectMilestoneAttachment[] = [];
  for (const [i, raw] of input.attachments.entries()) {
    const where = `attachment ${i + 1}`;
    if (!isObject(raw) || typeof raw.path !== "string") {
      problems.push(`${where} needs a path`);
      continue;
    }
    const path = raw.path.trim();
    if (path.length === 0 || path.length > PROJECT_LIMITS.attachmentPath || path.includes("\0") || !isAbsolute(path)) {
      problems.push(`${where}: the path must be absolute`);
      continue;
    }
    const resolved = resolve(path);
    if (!IMAGE_EXTENSIONS.has(extname(resolved).toLowerCase())) {
      problems.push(`${where}: only a .jpg, .jpeg or .png screenshot can be attached`);
      continue;
    }
    const inside = roots.some((root) => {
      const rel = relative(root, resolved);
      return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel) && !rel.includes(sep) && !rel.includes("/");
    });
    if (!inside) {
      problems.push(`${where}: the path must be a screenshot in the shots folder of a run of milestone ${input.milestone.id} (<stateDir>/${PROJECT_RUNS_DIR_NAME}/<runId>/${PROJECT_SHOTS_DIR_NAME}/)`);
      continue;
    }
    const caption = typeof raw.caption === "string" ? clip(raw.caption, PROJECT_LIMITS.shortText) : "";
    if (caption.length === 0) {
      problems.push(`${where} needs a caption`);
      continue;
    }
    let criteria: string[] | undefined;
    if (raw.criteria !== undefined) {
      const ids = cleanIdList(raw.criteria);
      if (ids === null) {
        problems.push(`${where}: criteria must be criterion ids`);
        continue;
      }
      const unknown = input.criterionIds === undefined ? [] : ids.filter((id) => !input.criterionIds!.has(id));
      if (unknown.length > 0) {
        problems.push(`${where}: the brief has no criterion ${unknown.join(", ")}`);
        continue;
      }
      if (ids.length > 0) criteria = ids;
    }
    if (out.some((a) => a.path === resolved)) continue;
    out.push({ path: resolved, caption, ...(criteria === undefined ? {} : { criteria }) });
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, attachments: out };
}

/** Stored attachments read back: shape only (they were checked when reported); malformed ones dropped. */
function readStoredAttachments(raw: readonly unknown[]): ProjectMilestoneAttachment[] {
  const out: ProjectMilestoneAttachment[] = [];
  for (const a of raw) {
    if (out.length >= PROJECT_LIMITS.attachments) break;
    if (!isObject(a) || typeof a.path !== "string" || typeof a.caption !== "string") continue;
    if (a.path.length === 0 || a.path.length > PROJECT_LIMITS.attachmentPath || a.path.includes("\0") || !isAbsolute(a.path)) continue;
    const caption = clip(a.caption, PROJECT_LIMITS.shortText);
    if (caption.length === 0) continue;
    const criteria = a.criteria === undefined ? [] : cleanIdList(a.criteria);
    if (criteria === null) continue;
    out.push({ path: a.path, caption, ...(criteria.length === 0 ? {} : { criteria }) });
  }
  return out;
}

/** Review blocks cleaned (issue #98): a task id and a one-line reason each, one per task, malformed dropped. */
function cleanReviewBlocks(raw: readonly unknown[]): ProjectReviewBlock[] {
  const out: ProjectReviewBlock[] = [];
  for (const b of raw) {
    if (out.length >= PROJECT_LIMITS.rows) break;
    if (!isObject(b)) continue;
    const taskId = cleanId(b.taskId);
    if (taskId === null || out.some((x) => x.taskId === taskId) || typeof b.reason !== "string") continue;
    const reason = clip(b.reason.replace(/\s+/g, " ").trim(), PROJECT_LIMITS.shortText);
    if (reason.length > 0) out.push({ taskId, reason });
  }
  return out;
}

/** Facts cleaned: known states, valid ids, the first per id, `why` clipped; malformed entries dropped. */
function cleanCriteriaFacts(raw: readonly unknown[]): ProjectCriterionFact[] {
  const out: ProjectCriterionFact[] = [];
  for (const f of raw) {
    if (out.length >= PROJECT_LIMITS.successCriteria) break;
    if (!isObject(f)) continue;
    const id = normalizeCriterionId(f.id);
    if (id === null || out.some((x) => x.id === id)) continue;
    if (!CRITERION_FACT_STATES.includes(f.state as CriterionFactState)) continue;
    const why = typeof f.why === "string" ? clip(f.why, PROJECT_LIMITS.shortText) : "";
    const reservation = f.state === "passed" && typeof f.reservation === "string" ? clip(f.reservation, PROJECT_LIMITS.shortText) : "";
    out.push({ id, state: f.state as CriterionFactState, ...(why.length === 0 ? {} : { why }), ...(reservation.length === 0 ? {} : { reservation }) });
  }
  return out;
}

function readMilestone(raw: unknown): ProjectMilestone | null {
  if (!isObject(raw)) return null;
  const id = cleanId(raw.id);
  if (id === null || typeof raw.title !== "string") return null;
  if (!MILESTONE_KINDS.includes(raw.kind as MilestoneKind)) return null;
  if (!MILESTONE_STATES.includes(raw.state as MilestoneState)) return null;
  if (!Array.isArray(raw.runIds) || !raw.runIds.every((r) => cleanId(r) !== null)) return null;
  if (raw.summary !== undefined && typeof raw.summary !== "string") return null;
  if (!isTime(raw.updatedAt)) return null;
  let corrections: MilestoneCorrection[] | undefined;
  if (raw.corrections !== undefined) {
    if (!Array.isArray(raw.corrections)) return null;
    corrections = [];
    for (const c of raw.corrections.slice(-PROJECT_LIMITS.corrections)) {
      if (!isObject(c) || typeof c.note !== "string" || !isTime(c.at)) return null;
      const note = clipText(c.note, PROJECT_LIMITS.correctionNote);
      if (note.length > 0) corrections.push({ note, at: c.at });
    }
  }
  // Pictures, facts and history are extras: a malformed entry is dropped, not the project.
  const attachments = Array.isArray(raw.attachments) ? readStoredAttachments(raw.attachments) : [];
  const facts = Array.isArray(raw.criteriaFacts) ? cleanCriteriaFacts(raw.criteriaFacts) : [];
  const blocks = Array.isArray(raw.reviewBlocks) ? cleanReviewBlocks(raw.reviewBlocks) : [];
  const override = isObject(raw.reviewOverride) && typeof raw.reviewOverride.note === "string" && isTime(raw.reviewOverride.at)
    ? {
        note: clipText(raw.reviewOverride.note, PROJECT_LIMITS.correctionNote),
        at: raw.reviewOverride.at as number,
        blocks: Array.isArray(raw.reviewOverride.blocks) ? cleanReviewBlocks(raw.reviewOverride.blocks) : [],
      }
    : undefined;
  const history = Array.isArray(raw.history)
    ? raw.history.map(readRevision).filter((r): r is ProjectMilestoneRevision => r !== null).slice(-PROJECT_LIMITS.history)
    : [];
  return {
    id,
    title: clip(raw.title, PROJECT_LIMITS.title),
    kind: raw.kind as MilestoneKind,
    state: raw.state as MilestoneState,
    runIds: (raw.runIds as string[]).slice(-PROJECT_LIMITS.runIds),
    ...(raw.summary === undefined ? {} : { summary: clipText(raw.summary, PROJECT_LIMITS.text) }),
    ...(corrections === undefined || corrections.length === 0 ? {} : { corrections }),
    ...(attachments.length === 0 ? {} : { attachments }),
    ...(facts.length === 0 ? {} : { criteriaFacts: facts }),
    ...(blocks.length === 0 ? {} : { reviewBlocks: blocks }),
    ...(override === undefined || override.note.length === 0 ? {} : { reviewOverride: override }),
    ...(isCount(raw.failedRefusals) && (raw.failedRefusals as number) > 0 ? { failedRefusals: Math.min(raw.failedRefusals as number, 99) } : {}),
    ...(history.length === 0 ? {} : { history }),
    updatedAt: raw.updatedAt,
  };
}

/**
 * A stored history entry (issue #77), or null when malformed: it is
 * dropped, not the milestone. Reads the first, richer shape too (tasks
 * as `{ taskId, title }`, full corrections and attachments) as the lean one.
 */
function readRevision(raw: unknown): ProjectMilestoneRevision | null {
  if (!isObject(raw) || !isTime(raw.supersededAt) || !Array.isArray(raw.tasks)) return null;
  const tasks: string[] = [];
  for (const t of raw.tasks.slice(0, PROJECT_LIMITS.rows)) {
    const title = typeof t === "string" ? t : isObject(t) && typeof t.title === "string" ? t.title : null;
    if (title === null) return null;
    tasks.push(clip(title, PROJECT_LIMITS.title));
  }
  if (typeof raw.title !== "string" || !MILESTONE_KINDS.includes(raw.kind as MilestoneKind)) return null;
  if (!MILESTONE_STATES.includes(raw.state as MilestoneState)) return null;
  if (!Array.isArray(raw.runIds) || !raw.runIds.every((r) => cleanId(r) !== null)) return null;
  if (raw.summary !== undefined && typeof raw.summary !== "string") return null;
  const count = (list: unknown, n: unknown): number =>
    Array.isArray(list) ? list.length : isCount(n) ? (n as number) : 0;
  const corrections = count(raw.corrections, raw.correctionCount);
  const attachments = count(raw.attachments, raw.attachmentCount);
  const facts = Array.isArray(raw.criteriaFacts) ? cleanCriteriaFacts(raw.criteriaFacts) : [];
  const summary = typeof raw.summary === "string" ? clipText(raw.summary, PROJECT_LIMITS.shortText) : "";
  const unknownCriteria: string[] = [];
  for (const u of Array.isArray(raw.unknownCriteria) ? raw.unknownCriteria.slice(0, PROJECT_LIMITS.successCriteria) : []) {
    const id = normalizeCriterionId(u);
    if (id !== null && !unknownCriteria.includes(id)) unknownCriteria.push(id);
  }
  const criteria: ProjectCriterion[] = [];
  for (const c of Array.isArray(raw.criteria) ? raw.criteria.slice(0, PROJECT_LIMITS.successCriteria) : []) {
    const id = isObject(c) ? normalizeCriterionId(c.id) : null;
    if (id === null || typeof (c as { text?: unknown }).text !== "string" || criteria.some((x) => x.id === id)) continue;
    criteria.push({ id, text: clipText((c as { text: string }).text, PROJECT_LIMITS.shortText) });
  }
  return {
    title: clip(raw.title, PROJECT_LIMITS.title),
    kind: raw.kind as MilestoneKind,
    state: raw.state as MilestoneState,
    tasks,
    runIds: (raw.runIds as string[]).slice(-PROJECT_LIMITS.runIds),
    ...(summary.length === 0 ? {} : { summary }),
    ...(facts.length === 0 ? {} : { criteriaFacts: facts }),
    ...(corrections === 0 ? {} : { correctionCount: corrections }),
    ...(attachments === 0 ? {} : { attachmentCount: attachments }),
    ...(criteria.length === 0 ? {} : { criteria }),
    ...(unknownCriteria.length === 0 ? {} : { unknownCriteria }),
    cause: raw.cause === "brief" || raw.cause === "brief-removed" ? raw.cause : "plan",
    supersededAt: raw.supersededAt as number,
  };
}

function readBrief(raw: unknown): ProjectBrief | null {
  if (!isObject(raw)) return null;
  if (!isVersion(raw.version)) return null;
  if (raw.status !== "draft" && raw.status !== "approved") return null;
  if (typeof raw.draftedAfterUntrusted !== "boolean") return null;
  if (raw.approvedAt !== undefined && !isTime(raw.approvedAt)) return null;
  if (typeof raw.what !== "string" || typeof raw.users !== "string" || typeof raw.how !== "string") return null;
  const game = readGame(raw.game);
  const criteria = cleanCriteria(raw.successCriteria, "lenient");
  if (game === null || criteria === null || typeof criteria === "string") return null;
  // Schema v2: read leniently (an unknown deliverable reads as absent, a malformed decision is dropped).
  const deliverable = typeof raw.deliverable === "string" && DELIVERABLES.has(raw.deliverable) ? (raw.deliverable as ProjectDeliverable) : undefined;
  const decisions = cleanDecisions(raw.decisions, "lenient") as ProjectBriefDecision[] | undefined;
  return {
    version: raw.version,
    what: clipText(raw.what, PROJECT_LIMITS.text),
    users: clipText(raw.users, PROJECT_LIMITS.text),
    how: clipText(raw.how, PROJECT_LIMITS.text),
    ...(game === undefined ? {} : { game }),
    ...(deliverable === undefined ? {} : { deliverable }),
    ...(decisions === undefined ? {} : { decisions }),
    successCriteria: criteria,
    status: raw.status,
    ...(raw.status === "approved" && raw.approvedAt !== undefined ? { approvedAt: raw.approvedAt as number } : {}),
    draftedAfterUntrusted: raw.draftedAfterUntrusted,
  };
}

function readGate(raw: unknown): ProjectGate | null {
  if (!isObject(raw)) return null;
  if (raw.kind === "none" || raw.kind === "brief" || raw.kind === "plan") return { kind: raw.kind };
  if (raw.kind === "milestone") {
    const id = cleanId(raw.id);
    return id === null ? null : { kind: "milestone", id };
  }
  return null;
}

/**
 * A stored project read back defensively (sessions are JSON on disk):
 * undefined when it is malformed anywhere — a wrong type, an unknown
 * status, a row naming a missing milestone, a gate with nothing to
 * decide. Over-long text is clipped and over-long lists cut to
 * {@link PROJECT_LIMITS}; totals are recomputed from the rows.
 */
export function normalizeProject(raw: unknown): ProjectState | undefined {
  if (!isObject(raw) || !Array.isArray(raw.milestones)) return undefined;
  const gate = readGate(raw.gate);
  if (gate === null) return undefined;
  const milestones: ProjectMilestone[] = [];
  for (const m of raw.milestones.slice(0, PROJECT_LIMITS.milestones)) {
    const read = readMilestone(m);
    if (read === null || milestones.some((x) => x.id === read.id)) return undefined;
    milestones.push(read);
  }
  const ids = new Set(milestones.map((m) => m.id));
  let brief: ProjectBrief | undefined;
  if (raw.brief !== undefined) {
    const read = readBrief(raw.brief);
    if (read === null) return undefined;
    brief = read;
  }
  let plan: ProjectPlan | undefined;
  if (raw.plan !== undefined) {
    const p = raw.plan;
    if (!isObject(p) || !Array.isArray(p.rows) || !isVersion(p.version)) return undefined;
    if (p.status !== "draft" && p.status !== "approved" && p.status !== "cancelled") return undefined;
    if (p.detail !== "compact" && p.detail !== "full") return undefined;
    if (p.approvedAt !== undefined && !isTime(p.approvedAt)) return undefined;
    if (p.draftedAfterUntrusted !== undefined && typeof p.draftedAfterUntrusted !== "boolean") return undefined;
    const rows: AssignmentRow[] = [];
    for (const r of p.rows.slice(0, PROJECT_LIMITS.rows)) {
      const read = readRow(r, ids);
      if (read === null || rows.some((x) => x.taskId === read.taskId)) return undefined;
      rows.push(read);
    }
    plan = {
      rows,
      totals: planTotals(rows),
      detail: p.detail,
      status: p.status,
      version: p.version,
      ...(p.status === "approved" && p.approvedAt !== undefined ? { approvedAt: p.approvedAt as number } : {}),
      // Older stores have no flag: nothing recorded the taint then.
      draftedAfterUntrusted: p.draftedAfterUntrusted === true,
      ...(p.status === "approved" && p.approvedWithUntrustedWarning === true ? { approvedWithUntrustedWarning: true as const } : {}),
      ...(() => {
        const resets = p.status === "draft" ? cleanVerdictResets(p.verdictResets, ids) : [];
        const retired = p.status === "draft" ? cleanVerdictResets(p.evidenceRetired, ids) : [];
        return { ...(resets.length === 0 ? {} : { verdictResets: resets }), ...(retired.length === 0 ? {} : { evidenceRetired: retired }) };
      })(),
    };
  }
  if (gate.kind === "brief" && brief === undefined) return undefined;
  if (gate.kind === "plan" && plan === undefined) return undefined;
  if (gate.kind === "milestone" && (plan === undefined || !ids.has(gate.id))) return undefined;
  if (raw.cancelledAt !== undefined && !isTime(raw.cancelledAt)) return undefined;
  // Extras: a malformed list reads as absent (the approved brief's own criteria stand in).
  const stored = raw.approvedCriteria === undefined ? null : cleanCriteria(raw.approvedCriteria, "lenient");
  const approvedCriteria = Array.isArray(stored) ? stored : brief?.status === "approved" ? brief.successCriteria : undefined;
  const storedDecisions = cleanDecisions(raw.approvedDecisions, "lenient");
  const approvedDecisions = Array.isArray(storedDecisions) ? storedDecisions : undefined;
  const decisionStatus = readStatusMap(raw.decisionStatus, PROJECT_DECISION_STATUSES);
  if (plan !== undefined && ((isObject(raw.plan) && raw.plan.checkResults !== undefined) || plan.rows.some((r) => r.checks !== undefined))) {
    const decisions = planDecisionsOf({ ...(approvedDecisions === undefined ? {} : { approvedDecisions }), ...(brief === undefined ? {} : { brief }), ...(decisionStatus === undefined ? {} : { decisionStatus }) });
    plan.checkResults = evaluatePlanChecks(plan.rows, approvedCriteria ?? [], {}, decisions);
  }
  if (raw.versionFloor !== undefined && !isCount(raw.versionFloor)) return undefined;
  const backlog = readBacklog(raw.backlog);
  const backlogStates = readStatusMap(raw.backlogStates, ["promoted", "dropped"] as const);
  return {
    ...(brief === undefined ? {} : { brief }),
    ...(plan === undefined ? {} : { plan }),
    milestones,
    gate,
    ...(approvedCriteria === undefined ? {} : { approvedCriteria }),
    ...(approvedDecisions === undefined ? {} : { approvedDecisions }),
    ...(isCount(raw.briefApprovals) && (raw.briefApprovals as number) > 0 ? { briefApprovals: raw.briefApprovals as number } : {}),
    ...(raw.cancelledAt === undefined ? {} : { cancelledAt: raw.cancelledAt as number }),
    ...(raw.versionFloor === undefined ? {} : { versionFloor: raw.versionFloor as number }),
    ...(backlog === undefined ? {} : { backlog }),
    ...(decisionStatus === undefined ? {} : { decisionStatus }),
    ...(backlogStates === undefined ? {} : { backlogStates }),
  };
}

/** Stored reset ids: known milestones, once each; anything else dropped. */
function cleanVerdictResets(raw: unknown, ids: ReadonlySet<string>): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const r of raw) {
    const id = cleanId(r);
    if (id !== null && ids.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The version after `current`, never at or below the project's {@link ProjectState.versionFloor}. */
function nextVersion(project: ProjectState | undefined, current: number | undefined): number {
  return Math.max(current ?? 0, project?.versionFloor ?? 0) + 1;
}

const floorOf = (project: ProjectState | undefined) =>
  project?.versionFloor === undefined ? {} : { versionFloor: project.versionFloor };

// ---------------------------------------------------------------- update

const FINISHED: ReadonlySet<MilestoneState> = new Set(["done", "failed", "reviewed"]);

/**
 * A re-drafted brief or plan would close the open milestone gate without
 * the person's decision on its result (issue #74): refused until they decide.
 */
function milestoneGateOpen(project: ProjectState | undefined): ProjectUpdateResult | null {
  if (project === undefined || project.cancelledAt !== undefined || project.gate.kind !== "milestone") return null;
  return {
    ok: false,
    error: {
      code: "awaiting-person",
      message: `Milestone ${project.gate.id}'s result waits for the person's decision: reply and wait for the person's decision before you change the brief or the plan.`,
    },
  };
}

function briefUpdate(
  project: ProjectState | undefined,
  update: Extract<ProjectUpdate, { kind: "brief" }>,
  now: number,
): ProjectUpdateResult {
  const waiting = milestoneGateOpen(project);
  if (waiting !== null) return waiting;
  // After a cancel, a new brief is a new project.
  const base: ProjectState | undefined = project?.cancelledAt !== undefined ? undefined : project;
  const draft = cleanBriefDraft(update.brief, base?.brief?.successCriteria);
  if (typeof draft === "string") return invalid(draft);
  const brief: ProjectBrief = {
    version: nextVersion(project, base?.brief?.version),
    ...draft,
    status: "draft",
    draftedAfterUntrusted: update.draftedAfterUntrusted === true,
  };
  // Criteria are judged when the person approves the brief (issue #80), not per draft.
  const approvedCriteria = base === undefined ? undefined : approvedCriteriaOf(base);
  const approvedDecisions = base === undefined ? [] : approvedDecisionsOf(base);
  const milestones = (base?.milestones ?? []).map((m) => (m.state === "approved" ? { ...m, state: "planned" as const, updatedAt: now } : m));
  // The plan was approved against the old brief: back to a draft, and
  // milestones not started yet wait for its approval again.
  const plan: ProjectPlan | undefined =
    base?.plan === undefined || base.plan.status === "cancelled"
      ? base?.plan
      : {
          ...withoutApproval(base.plan),
          status: "draft",
          version: base.plan.version + 1,
          ...mergeResets(base.plan, freshResets(base.milestones, milestones), new Set(milestones.map((m) => m.id))),
        };
  return {
    ok: true,
    project: {
      brief,
      ...(plan === undefined ? {} : { plan }),
      milestones,
      gate: { kind: "brief" },
      ...(approvedCriteria === undefined ? {} : { approvedCriteria }),
      ...(approvedDecisions.length === 0 ? {} : { approvedDecisions }),
      ...(base?.briefApprovals === undefined ? {} : { briefApprovals: base.briefApprovals }),
      ...floorOf(project),
      // The backlog is the folder's: it outlives a cancel; decision statuses belong to the project's decisions.
      ...personCalls(project, base !== undefined),
    },
  };
}

function withoutResets(plan: ProjectPlan): ProjectPlan {
  const copy = { ...plan };
  delete copy.verdictResets;
  delete copy.evidenceRetired;
  return copy;
}

/**
 * Titles of the milestones whose verdict or runs `update` would move to
 * their history (issue #77), as the draft plan would name them; empty
 * when the update would be refused. For a director tool's result.
 */
export function projectVerdictResets(project: ProjectState | undefined, update: ProjectUpdate): string[] {
  const after = applyProjectUpdate(project, update, 0);
  if (!after.ok) return [];
  const fresh = freshResets(project?.milestones ?? [], after.project.milestones);
  return after.project.milestones.filter((m) => fresh.includes(m.id)).map((m) => m.title);
}

function withoutApproval<T extends { approvedAt?: number; approvedWithUntrustedWarning?: true }>(value: T): T {
  const copy = { ...value };
  delete copy.approvedAt;
  delete copy.approvedWithUntrustedWarning;
  return copy;
}

/** A milestone's tasks in the given rows, by task id. */
function milestoneTasks(rows: readonly AssignmentRow[], id: string): ProjectMilestoneTask[] {
  return rows
    .filter((r) => r.milestoneId === id)
    .map((r) => ({ taskId: r.taskId, title: r.title }))
    .sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
}

/** A task title as the work it names: case and runs of whitespace are editorial. */
const workText = (title: string): string => title.replace(/\s+/g, " ").trim().toLowerCase();

/** A milestone's task titles as work, sorted: ids are names, not work. */
const workTitles = (tasks: readonly ProjectMilestoneTask[]): string[] => tasks.map((t) => workText(t.title)).sort();

/**
 * Whether a re-plan changed the work a milestone's evidence stands on
 * (issue #77): its kind, or its tasks compared by title (a task added,
 * removed or moved, or a title changed beyond case and whitespace). Task
 * ids, the milestone's own title, the order of milestones and a task's
 * worker, reviewer or estimate are not the work.
 */
export function milestoneWorkChanged(
  before: { kind: MilestoneKind; tasks: readonly ProjectMilestoneTask[] },
  after: { kind: MilestoneKind; tasks: readonly ProjectMilestoneTask[] },
): boolean {
  if (before.kind !== after.kind) return true;
  const a = workTitles(before.tasks);
  const b = workTitles(after.tasks);
  return a.length !== b.length || a.some((t, i) => t !== b[i]);
}

/** Whether every task of `before` is still in `after` (by work title): the re-plan only added tasks. */
function onlyAddsTasks(before: readonly ProjectMilestoneTask[], after: readonly ProjectMilestoneTask[]): boolean {
  const left = new Map<string, number>();
  for (const t of workTitles(after)) left.set(t, (left.get(t) ?? 0) + 1);
  for (const t of workTitles(before)) {
    const n = left.get(t) ?? 0;
    if (n === 0) return false;
    left.set(t, n - 1);
  }
  return true;
}

/** A person's verdict or a reported result: what a change of work must not carry over. */
const VERDICT: ReadonlySet<MilestoneState> = new Set(["done", "failed", "reviewed"]);

/** Whether a milestone holds anything a revision should keep. */
const hasEvidence = (m: ProjectMilestone): boolean =>
  m.runIds.length > 0 ||
  m.summary !== undefined ||
  m.corrections !== undefined ||
  m.attachments !== undefined ||
  m.criteriaFacts !== undefined;

/**
 * The milestone started over on new work (issue #77): `planned`, no
 * runs, report, corrections, pictures or facts; what it held moves to
 * `history` with the work it was for (`tasks`, from the plan before).
 */
function supersede(
  old: ProjectMilestone,
  oldTasks: ProjectMilestoneTask[],
  now: number,
  cause: "plan" | "brief",
  criteria: readonly ProjectCriterion[],
): ProjectMilestone {
  const history = [...(old.history ?? [])];
  if (hasEvidence(old)) {
    const summary = old.summary === undefined ? "" : clipText(old.summary, PROJECT_LIMITS.shortText);
    const cited = criteria.filter((c) => citesCriteria(old, new Set([c.id]))).map((c) => ({ id: c.id, text: c.text }));
    history.push({
      title: old.title,
      kind: old.kind,
      state: old.state,
      tasks: oldTasks.map((t) => t.title),
      runIds: old.runIds,
      ...(summary.length === 0 ? {} : { summary }),
      ...(old.criteriaFacts === undefined ? {} : { criteriaFacts: old.criteriaFacts }),
      ...(old.corrections === undefined || old.corrections.length === 0 ? {} : { correctionCount: old.corrections.length }),
      ...(old.attachments === undefined || old.attachments.length === 0 ? {} : { attachmentCount: old.attachments.length }),
      ...(cited.length === 0 ? {} : { criteria: cited }),
      cause,
      supersededAt: now,
    });
  }
  const kept = history.slice(-PROJECT_LIMITS.history);
  return { id: old.id, title: old.title, kind: old.kind, state: "planned", runIds: [], ...(kept.length === 0 ? {} : { history: kept }), updatedAt: now };
}

/** Ids whose evidence an update just moved to history (a new newest revision). */
function freshResets(before: readonly ProjectMilestone[], after: readonly ProjectMilestone[]): string[] {
  const old = new Map(before.map((m) => [m.id, m.history?.at(-1)]));
  return after
    .filter((m) => {
      const newest = m.history?.at(-1);
      // A retired criterion's evidence is not a reset: the verdict stands.
      return newest !== undefined && old.has(m.id) && newest !== old.get(m.id) && newest.cause !== "brief-removed";
    })
    .map((m) => m.id);
}

/**
 * The draft's {@link ProjectPlan.verdictResets}: the milestones this
 * update started over that held evidence, after those an earlier draft
 * (not yet approved) already reset; only ids the plan still lists.
 */
/** The draft's {@link ProjectPlan.evidenceRetired}: an earlier draft's, then `fresh`; only ids the plan lists. */
function mergeRetired(previous: ProjectPlan | undefined, fresh: readonly string[], ids: ReadonlySet<string>): { evidenceRetired?: string[] } {
  const carried = previous?.status === "draft" ? (previous.evidenceRetired ?? []) : [];
  const all = [...new Set([...carried, ...fresh])].filter((id) => ids.has(id));
  return all.length === 0 ? {} : { evidenceRetired: all };
}

function mergeResets(previous: ProjectPlan | undefined, fresh: readonly string[], ids: ReadonlySet<string>): { verdictResets?: string[] } {
  const carried = previous?.status === "draft" ? (previous.verdictResets ?? []) : [];
  const all = [...new Set([...carried, ...fresh])].filter((id) => ids.has(id));
  return all.length === 0 ? {} : { verdictResets: all };
}

/** The last approved brief's criteria: recorded, or (an older store) the brief's own while it is approved. */
function approvedCriteriaOf(project: ProjectState): ProjectCriterion[] | undefined {
  return project.approvedCriteria ?? (project.brief?.status === "approved" ? project.brief.successCriteria : undefined);
}

/**
 * The person approves the brief (issue #80): its criteria are judged
 * against the last approved brief's ({@link judgeCriteria}); without one
 * no baseline only a project saved before issue #80 can hold evidence,
 * and all of it that cites a criterion is retired (issue #83): which old
 * result still applies cannot be told. A reset lands on the draft plan's
 * `verdictResets`; a milestone that kept its state but lost evidence
 * this way, or a reviewed or done one left with no facts or pictures at
 * all, on `evidenceRetired`.
 */
function approveBrief(project: ProjectState, now: number): ProjectState {
  const brief = project.brief!;
  const before = approvedCriteriaOf(project);
  const rows = project.plan?.rows ?? [];
  const milestones =
    before === undefined
      ? retireOrphans(project.milestones, rows, [], now)
      : judgeCriteria(retireOrphans(project.milestones, rows, before, now), rows, before, brief.successCriteria, now);
  const hasCriteriaEvidence = (m: ProjectMilestone): boolean => (m.criteriaFacts?.length ?? 0) > 0 || (m.attachments?.length ?? 0) > 0;
  const retired = milestones
    .filter((m, i) => {
      const was = project.milestones[i]!;
      if (m === was) return false;
      // Without a baseline every milestone that lost evidence; otherwise
      // a finished one whose only evidence went (its verdict stands bare).
      if (before === undefined) return true;
      return m.state === was.state && (m.state === "reviewed" || m.state === "done") && hasCriteriaEvidence(was) && !hasCriteriaEvidence(m);
    })
    .map((m) => m.id);
  let plan =
    project.plan === undefined || project.plan.status !== "draft"
      ? project.plan
      : (() => {
          const { verdictResets: _old, evidenceRetired: _retired, ...rest } = project.plan;
          const ids = new Set(milestones.map((m) => m.id));
          return { ...rest, ...mergeResets(project.plan, freshResets(project.milestones, milestones), ids), ...mergeRetired(project.plan, retired, ids) };
        })();
  const approvedDecisions = (brief.decisions ?? []).map((d) => ({ ...d }));
  if (plan !== undefined && (plan.checkResults !== undefined || plan.rows.some((r) => r.checks !== undefined))) {
    plan = { ...plan, checkResults: evaluatePlanChecks(plan.rows, brief.successCriteria, {}, planDecisionsOf({ approvedDecisions, decisionStatus: project.decisionStatus })) };
  }
  const { approvedDecisions: _before, ...rest } = project;
  return {
    ...rest,
    brief: { ...brief, status: "approved", approvedAt: now },
    ...(plan === undefined ? {} : { plan }),
    milestones,
    approvedCriteria: brief.successCriteria.map((c) => ({ ...c })),
    ...(approvedDecisions.length === 0 ? {} : { approvedDecisions }),
    // A store from before the count that had an approved brief: at least two now.
    briefApprovals: project.briefApprovals !== undefined ? project.briefApprovals + 1 : before === undefined ? 1 : 2,
    gate: { kind: "none" },
  };
}

/**
 * Retires evidence citing a criterion id absent from the last approved
 * brief (issue #83): a project saved before issue #80 kept it after the
 * criterion was removed, and the id could since be reused for another
 * requirement. Same path as a removal (cause `brief-removed`); the text
 * is unknown, so the entry lists the ids in `unknownCriteria`.
 */
function retireOrphans(
  milestones: readonly ProjectMilestone[],
  rows: readonly AssignmentRow[],
  baseline: readonly ProjectCriterion[],
  now: number,
): ProjectMilestone[] {
  const known = new Set(baseline.map((c) => c.id));
  return milestones.map((m) => {
    const cited = [...(m.criteriaFacts ?? []).map((f) => f.id), ...(m.attachments ?? []).flatMap((a) => a.criteria ?? [])];
    const orphans = new Set(cited.filter((id) => !known.has(id)));
    return orphans.size === 0 ? m : retireCriteria(m, orphans, milestoneTasks(rows, m.id), [], now);
  });
}

/** Ids of kept criteria whose text a brief revision changed beyond case and whitespace (issue #77). */
function changedCriteria(before: readonly ProjectCriterion[], after: readonly ProjectCriterion[]): Set<string> {
  const now = new Map(after.map((c) => [c.id, workText(c.text)]));
  return new Set(before.filter((c) => now.has(c.id) && now.get(c.id) !== workText(c.text)).map((c) => c.id));
}

/** Ids of criteria a brief revision removed (issue #80). */
function removedCriteria(before: readonly ProjectCriterion[], after: readonly ProjectCriterion[]): Set<string> {
  const now = new Set(after.map((c) => c.id));
  return new Set(before.filter((c) => !now.has(c.id)).map((c) => c.id));
}

/**
 * The milestones after a brief's criteria went from `before` to `after`.
 * A criterion whose text changed voids the evidence citing it: those
 * milestones start over ({@link supersede}, cause `brief`). A removed one
 * only retires its own evidence ({@link retireCriteria}): the verdict on
 * the remaining criteria stands, and an id reused later has no facts.
 */
function judgeCriteria(
  milestones: readonly ProjectMilestone[],
  rows: readonly AssignmentRow[],
  before: readonly ProjectCriterion[],
  after: readonly ProjectCriterion[],
  now: number,
): ProjectMilestone[] {
  const changed = changedCriteria(before, after);
  const removed = removedCriteria(before, after);
  return milestones.map((m) => {
    if (changed.size > 0 && citesCriteria(m, changed)) return supersede(m, milestoneTasks(rows, m.id), now, "brief", before);
    if (removed.size > 0 && citesCriteria(m, removed)) return retireCriteria(m, removed, milestoneTasks(rows, m.id), before, now);
    return m;
  });
}

/**
 * Drops a milestone's evidence for removed criteria (issue #80): their
 * facts, and pictures citing only removed criteria (a picture that also
 * cites a kept one stays, without the removed ids). State, runs and
 * report stay. What went is recorded as a history entry, cause
 * `brief-removed`, with the criteria's text: the milestone's state at
 * the time, the dropped facts and the count of dropped pictures.
 */
function retireCriteria(
  m: ProjectMilestone,
  removed: ReadonlySet<string>,
  tasks: readonly ProjectMilestoneTask[],
  criteria: readonly ProjectCriterion[],
  now: number,
): ProjectMilestone {
  const facts = m.criteriaFacts ?? [];
  const droppedFacts = facts.filter((f) => removed.has(f.id));
  const keptFacts = facts.filter((f) => !removed.has(f.id));
  let droppedPictures = 0;
  const keptPictures: ProjectMilestoneAttachment[] = [];
  for (const a of m.attachments ?? []) {
    if (a.criteria === undefined || a.criteria.length === 0) {
      keptPictures.push(a);
      continue;
    }
    const left = a.criteria.filter((id) => !removed.has(id));
    if (left.length === 0) droppedPictures++;
    else keptPictures.push(left.length === a.criteria.length ? a : { ...a, criteria: left });
  }
  const cited = criteria.filter((c) => removed.has(c.id) && citesCriteria(m, new Set([c.id]))).map((c) => ({ id: c.id, text: c.text }));
  const unknown = [...removed].filter((id) => !cited.some((c) => c.id === id) && citesCriteria(m, new Set([id])));
  const entry: ProjectMilestoneRevision = {
    title: m.title,
    kind: m.kind,
    state: m.state,
    tasks: tasks.map((t) => t.title),
    runIds: m.runIds,
    ...(droppedFacts.length === 0 ? {} : { criteriaFacts: droppedFacts }),
    ...(droppedPictures === 0 ? {} : { attachmentCount: droppedPictures }),
    ...(cited.length === 0 ? {} : { criteria: cited }),
    ...(unknown.length === 0 ? {} : { unknownCriteria: unknown }),
    cause: "brief-removed",
    supersededAt: now,
  };
  const next: ProjectMilestone = { ...m, history: [...(m.history ?? []), entry].slice(-PROJECT_LIMITS.history), updatedAt: now };
  delete next.criteriaFacts;
  delete next.attachments;
  return {
    ...next,
    ...(keptFacts.length === 0 ? {} : { criteriaFacts: keptFacts }),
    ...(keptPictures.length === 0 ? {} : { attachments: keptPictures }),
  };
}

/** Whether a milestone's evidence cites one of these criteria (its facts or its pictures). */
const citesCriteria = (m: ProjectMilestone, ids: ReadonlySet<string>): boolean =>
  (m.criteriaFacts ?? []).some((f) => ids.has(f.id)) || (m.attachments ?? []).some((a) => (a.criteria ?? []).some((id) => ids.has(id)));

/**
 * A milestone as a re-plan leaves it. Finished and running work keeps
 * its state and evidence; the rest waits for the new plan's approval
 * (keeping its runs). When the work itself changed
 * ({@link milestoneWorkChanged}, issue #77), no verdict, run or report
 * of the old work carries over: the evidence moves to `history` with the
 * work it was for, and the milestone starts over as `planned`.
 */
function replannedMilestone(
  next: { id: string; title: string; kind: MilestoneKind },
  old: ProjectMilestone | undefined,
  oldRows: readonly AssignmentRow[],
  rows: readonly AssignmentRow[],
  now: number,
  criteria: readonly ProjectCriterion[],
): ProjectMilestone {
  const base = { id: next.id, title: next.title, kind: next.kind };
  if (old === undefined) return { ...base, state: "planned", runIds: [], updatedAt: now };
  const oldTasks = milestoneTasks(oldRows, old.id);
  const newTasks = milestoneTasks(rows, next.id);
  // Work with no verdict yet (planned, approved or running) keeps its runs
  // when the re-plan only adds tasks to it: those runs did part of it.
  const grows = !VERDICT.has(old.state) && old.kind === next.kind && onlyAddsTasks(oldTasks, newTasks);
  if (!grows && milestoneWorkChanged({ kind: old.kind, tasks: oldTasks }, { kind: next.kind, tasks: newTasks })) {
    return { ...supersede(old, oldTasks, now, "plan", criteria), ...base };
  }
  const keep = FINISHED.has(old.state) || old.state === "in_progress";
  return {
    ...base,
    state: keep ? old.state : "planned",
    runIds: old.runIds,
    ...(keep && old.summary !== undefined ? { summary: old.summary } : {}),
    ...(keep && old.corrections !== undefined ? { corrections: old.corrections } : {}),
    // The result's evidence stays with it (issue #74).
    ...(keep && old.attachments !== undefined ? { attachments: old.attachments } : {}),
    ...(keep && old.criteriaFacts !== undefined ? { criteriaFacts: old.criteriaFacts } : {}),
    ...(old.history === undefined ? {} : { history: old.history }),
    updatedAt: now,
  };
}

function planUpdate(
  project: ProjectState | undefined,
  update: Extract<ProjectUpdate, { kind: "plan" }>,
  now: number,
): ProjectUpdateResult {
  if (project?.cancelledAt !== undefined) {
    return { ok: false, error: { code: "cancelled", message: "The person cancelled this project; draft a new brief to start over." } };
  }
  if (project?.brief?.status !== "approved") {
    return { ok: false, error: { code: "brief-not-approved", message: "The brief is not approved yet: draft it with project.brief and reply so the person can approve it." } };
  }
  const waiting = milestoneGateOpen(project);
  if (waiting !== null) return waiting;
  if (!Array.isArray(update.milestones) || update.milestones.length === 0) return invalid("the plan needs at least one milestone");
  if (update.milestones.length > PROJECT_LIMITS.milestones) return invalid(`at most ${PROJECT_LIMITS.milestones} milestones`);
  if (!Array.isArray(update.rows) || update.rows.length === 0) return invalid("the plan needs at least one task");
  if (update.rows.length > PROJECT_LIMITS.rows) return invalid(`at most ${PROJECT_LIMITS.rows} tasks; merge small tasks`);
  if (update.detail !== "compact" && update.detail !== "full") return invalid("detail must be compact or full");
  const previous = new Map(project.milestones.map((m) => [m.id, m]));
  const drafted: Array<{ id: string; title: string; kind: MilestoneKind }> = [];
  for (const [i, m] of update.milestones.entries()) {
    const id = cleanId(m?.id);
    if (id === null) return invalid(`milestone ${i + 1} needs a short id without spaces`);
    if (drafted.some((x) => x.id === id)) return invalid(`milestone id ${id} is used twice`);
    if (!MILESTONE_KINDS.includes(m.kind)) return invalid(`milestone ${id} kind must be one of ${MILESTONE_KINDS.join("|")}`);
    const title = typeof m.title === "string" ? clip(m.title, PROJECT_LIMITS.title) : "";
    if (title.length === 0) return invalid(`milestone ${id} needs a title`);
    drafted.push({ id, title, kind: m.kind });
  }
  const ids = new Set(drafted.map((m) => m.id));
  const rows: AssignmentRow[] = [];
  for (const [i, r] of update.rows.entries()) {
    const read = readRow(r, ids);
    if (read === null) {
      const named = isObject(r) && typeof r.milestoneId === "string" && !ids.has(r.milestoneId.trim());
      return invalid(named ? `task ${i + 1} names milestone ${String(r.milestoneId)}, which the plan does not list` : `task ${i + 1} is malformed`);
    }
    if (rows.some((x) => x.taskId === read.taskId)) return invalid(`task id ${read.taskId} is used twice`);
    // The director's plan carries no person's pick of its own; a row whose
    // worker and reviewer match the person's pick on the plan before
    // keeps it (issue #74), so a re-plan cannot quietly undo their
    // "no review" or their reviewer.
    delete read.reviewerByPerson;
    const before = project.plan?.rows.find((x) => x.taskId === read.taskId);
    if (before?.reviewerByPerson === true && before.worker === read.worker && before.reviewer === read.reviewer) {
      read.reviewerByPerson = true;
    }
    rows.push(read);
  }
  const milestones = drafted.map((m) => replannedMilestone(m, previous.get(m.id), project.plan?.rows ?? [], rows, now, project.brief?.successCriteria ?? []));
  const plan: ProjectPlan = {
    rows,
    checkResults: evaluatePlanChecks(rows, project.approvedCriteria ?? project.brief.successCriteria, {}, planDecisionsOf(project)),
    totals: planTotals(rows),
    detail: update.detail,
    status: "draft",
    version: nextVersion(project, project.plan?.version),
    draftedAfterUntrusted: update.draftedAfterUntrusted === true,
    ...mergeResets(project.plan, freshResets(project.milestones, milestones), ids),
    ...mergeRetired(project.plan, [], ids),
  };
  return {
    ok: true,
    project: {
      brief: project.brief,
      plan,
      milestones,
      gate: { kind: "plan" },
      ...(project.approvedCriteria === undefined ? {} : { approvedCriteria: project.approvedCriteria }),
      ...(project.approvedDecisions === undefined ? {} : { approvedDecisions: project.approvedDecisions }),
      ...(project.briefApprovals === undefined ? {} : { briefApprovals: project.briefApprovals }),
      ...floorOf(project),
      ...personCalls(project, true),
    },
  };
}

function milestoneUpdate(
  project: ProjectState | undefined,
  update: Extract<ProjectUpdate, { kind: "milestone" | "milestone_run" }>,
  now: number,
  options: ProjectUpdateOptions,
): ProjectUpdateResult {
  if (project?.cancelledAt !== undefined) {
    return { ok: false, error: { code: "cancelled", message: "The person cancelled this project." } };
  }
  if (project?.plan?.status !== "approved") {
    return { ok: false, error: { code: "plan-not-approved", message: "The plan is not approved yet." } };
  }
  const index = project.milestones.findIndex((m) => m.id === update.id);
  if (index < 0) {
    return { ok: false, error: { code: "unknown-milestone", message: `The plan has no milestone ${update.id}.` } };
  }
  const current = project.milestones[index]!;
  if (update.kind === "milestone" && update.holdForCorrection === true) {
    const held = [...project.milestones];
    held[index] = { ...current, failedRefusals: (current.failedRefusals ?? 0) + 1, updatedAt: now };
    return { ok: true, project: { ...project, milestones: held } };
  }
  const milestones = [...project.milestones];
  if (update.kind === "milestone_run") {
    if (current.state !== "approved" && current.state !== "in_progress") {
      return { ok: false, error: { code: "milestone-not-approved", message: `Milestone ${update.id} is not approved to run.` } };
    }
    const runId = cleanId(update.runId);
    if (runId === null) return invalid("a run id is a short id without spaces");
    const runIds = current.runIds.includes(runId) ? current.runIds : [...current.runIds, runId].slice(-PROJECT_LIMITS.runIds);
    milestones[index] = { ...current, state: "in_progress", runIds, updatedAt: now };
    return { ok: true, project: { ...project, milestones } };
  }
  // One result at the person at a time (issue #74): another report would
  // replace the gate, and the person would never decide on the first.
  if (project.gate.kind === "milestone" && project.gate.id !== current.id) {
    return {
      ok: false,
      error: {
        code: "awaiting-person",
        message: `Milestone ${project.gate.id}'s result waits for the person's decision: reply and wait for it before you report milestone ${current.id}.`,
      },
    };
  }
  // A report: only for work the person let run (a failed one may be re-reported after a retry).
  if (current.state !== "approved" && current.state !== "in_progress" && current.state !== "failed" && current.state !== "done") {
    return { ok: false, error: { code: "milestone-not-approved", message: `Milestone ${update.id} is not approved; report only the milestone you ran.` } };
  }
  if (update.state !== "done" && update.state !== "failed") return invalid("state must be done or failed");
  // Done stands on a run since the milestone was (re)approved: a run
  // makes it `in_progress`, and a done result stays done when re-reported.
  // Approved (no run yet, or a correction or failed result re-approved it)
  // or failed (no run since that report) has nothing to be done over.
  if (update.state === "done" && current.state !== "in_progress" && current.state !== "done") {
    return {
      ok: false,
      error: {
        code: "milestone-not-run",
        message: `Milestone ${update.id} has no run since ${current.state === "failed" ? "its failed report" : "it was approved"}: delegate its tasks with fusion.delegate, then report it done (or report it failed with the reason).`,
      },
    };
  }
  const summary = typeof update.summary === "string" ? clipText(update.summary, PROJECT_LIMITS.text) : "";
  if (summary.length === 0) return invalid("the report needs a summary of the result");
  let attachments: ProjectMilestoneAttachment[] = [];
  if (update.attachments !== undefined) {
    if (!Array.isArray(update.attachments)) return invalid("attachments must be a list");
    if (update.attachments.length > 0) {
      if (options.stateDir === undefined) return invalid("attachments cannot be checked here; report without them");
      const checked = validateMilestoneAttachments({
        stateDir: options.stateDir,
        milestone: current,
        attachments: update.attachments,
        criterionIds: new Set(criteriaById(project.brief).keys()),
      });
      if (!checked.ok) return invalid(checked.problems.join("; "));
      attachments = checked.attachments;
    }
  }
  // A new report describes a new result: the old pictures go with it.
  const reported: ProjectMilestone = { ...current, state: update.state, summary, updatedAt: now };
  delete reported.attachments;
  delete reported.criteriaFacts;
  delete reported.reviewBlocks;
  const facts = Array.isArray(update.criteriaFacts) ? cleanCriteriaFacts(update.criteriaFacts) : [];
  if (facts.length > 0) reported.criteriaFacts = facts;
  const blocks = Array.isArray(update.reviewBlocks) ? cleanReviewBlocks(update.reviewBlocks) : [];
  if (blocks.length > 0) reported.reviewBlocks = blocks;
  milestones[index] = attachments.length === 0 ? reported : { ...reported, attachments };
  return {
    ok: true,
    project: {
      ...project,
      plan: { ...project.plan, version: project.plan.version + 1 },
      milestones,
      gate: { kind: "milestone", id: current.id },
    },
  };
}

/**
 * Fold one model (or runtime) update into the project. Pure. Every
 * accepted brief or plan update is a draft with a bumped version; a
 * report opens the milestone gate. Errors carry a message for the model.
 */
export function applyProjectUpdate(
  project: ProjectState | undefined,
  update: ProjectUpdate,
  now: number,
  options: ProjectUpdateOptions = {},
): ProjectUpdateResult {
  switch (update.kind) {
    case "brief":
      return briefUpdate(project, update, now);
    case "plan":
      return planUpdate(project, update, now);
    case "milestone":
    case "milestone_run":
      return milestoneUpdate(project, update, now, options);
    default:
      return invalid("unknown project update");
  }
}

// -------------------------------------------------------------- decision

function refuse(error: ProjectDecisionError): ProjectDecisionResult {
  return { ok: false, error };
}

/** A done or failed result the person has not decided on yet. */
const unreviewed = (m: ProjectMilestone): boolean => m.state === "done" || m.state === "failed";

/**
 * The milestone an approval would approve next (issues #74, #80): the
 * first `planned` one in plan order, but only while nothing else is open
 * anywhere in the plan (no milestone approved or in_progress, no done or
 * failed result the person has not decided on). Undefined otherwise. The
 * one rule {@link approveNext} and the runtime's daily-limit check share.
 */
export function milestoneToApproveNext(milestones: readonly ProjectMilestone[]): string | undefined {
  if (milestones.some((m) => m.state === "approved" || m.state === "in_progress" || unreviewed(m))) return undefined;
  return milestones.find((m) => m.state === "planned")?.id;
}

/** Approves {@link milestoneToApproveNext}, if any. */
function approveNext(milestones: readonly ProjectMilestone[], now: number): ProjectMilestone[] {
  const next = milestoneToApproveNext(milestones);
  return milestones.map((m) => (m.id === next ? { ...m, state: "approved" as const, updatedAt: now } : m));
}

function editRows(
  plan: ProjectPlan,
  edits: NonNullable<ProjectEdits["rows"]>,
  replan: ProjectDecisionOptions["replan"],
): AssignmentRow[] | string {
  const rows = plan.rows.map((r) => ({ ...r }));
  const touched = new Set<string>();
  for (const edit of edits) {
    const row = rows.find((r) => r.taskId === edit.taskId);
    if (row === undefined) return `the plan has no task ${String(edit.taskId)}`;
    if (edit.worker !== undefined) {
      const ref = cleanRef(edit.worker);
      if (ref === null) return `task ${row.taskId}: worker must be "<providerId>:<model>"`;
      row.worker = ref;
    }
    if (edit.reviewer !== undefined) {
      const ref = edit.reviewer === null ? null : cleanRef(edit.reviewer);
      if (edit.reviewer !== null && ref === null) return `task ${row.taskId}: reviewer must be "<providerId>:<model>" or null`;
      row.reviewer = ref;
      row.reviewerByPerson = true;
    }
    touched.add(row.taskId);
  }
  if (replan !== undefined) return replan(rows, "edit");
  return rows.map((r) =>
    touched.has(r.taskId)
      ? (({ local: _local, ...rest }) => ({ ...rest, reason: "edited by the person", basis: "preset" as const, samples: 0, estCostUsd: null, estMs: null }))(r)
      : r,
  );
}

/**
 * The person's decision at the current gate. Pure. Refused when there
 * is no project, the gate or version differs from what the person saw,
 * the gate does not allow the verdict, or (approve, brief or plan gate)
 * a hard cap is exceeded.
 *  - approve brief: approved; gate none; the director drafts the plan.
 *  - approve plan: approved; the first planned milestone is approved.
 *  - approve milestone: a done result becomes `reviewed` and the next
 *    planned milestone is approved; a failed one goes back to `approved`.
 *    Never refused for a hard cap (issue #74): the result is decided
 *    (done: `reviewed`; failed: `planned`) and the next run waits at a
 *    plan gate (plan back to draft) for the person to resolve the cap.
 *  - edit / cheaper / quality: the draft changes, its version bumps, the
 *    gate stays open for the new version. At a milestone gate, `edit`
 *    is the person's correction (`edits.note`): the milestone goes back
 *    to `approved` for another run with the note on `corrections`.
 *  - cancel: the project is cancelled (`cancelledAt`, plan `cancelled`).
 */
export function applyProjectDecision(
  project: ProjectState | undefined,
  decision: ProjectDecision,
  options: ProjectDecisionOptions,
): ProjectDecisionResult {
  if (project === undefined || project.cancelledAt !== undefined) {
    return refuse({ code: "no-project", message: "There is no open project to decide on." });
  }
  if (!sameGate(project.gate, decision.gate)) {
    return refuse({ code: "wrong-gate", message: "The project is waiting at a different gate; reload it.", current: project.gate });
  }
  const current = gateVersion(project);
  if (current === null || decision.version !== current) {
    return refuse({ code: "stale-version", message: "The project changed since it was shown; reload it.", current });
  }
  const allowed = allowedProjectVerdicts(project.gate, project);
  if (!allowed.includes(decision.verdict)) {
    return refuse({ code: "verdict-not-allowed", message: `This gate accepts ${allowed.join(", ")}.`, allowed });
  }
  const now = options.now;
  const gate = project.gate;

  if (decision.verdict === "cancel") {
    return {
      ok: true,
      project: {
        ...project,
        ...(project.plan === undefined ? {} : { plan: { ...withoutApproval(project.plan), status: "cancelled" as const } }),
        gate: { kind: "none" },
        cancelledAt: now,
        versionFloor: Math.max(project.versionFloor ?? 0, project.brief?.version ?? 0, project.plan?.version ?? 0),
      },
    };
  }

  if (decision.verdict === "approveOverReview" && gate.kind === "milestone") {
    // The person's call over open reviews (issue #98): with a note, the
    // result is approved as done, the blocks and the note kept on it.
    const raw = decision.edits?.note;
    const note = typeof raw === "string" ? clipText(raw, PROJECT_LIMITS.correctionNote) : "";
    if (note.length === 0) {
      return refuse({ code: "invalid", message: "Approving over an open review needs a note saying why." });
    }
    const overridden: ProjectState = {
      ...project,
      milestones: project.milestones.map((m) => {
        if (m.id !== gate.id) return m;
        const { reviewBlocks: blocks = [], ...rest } = m;
        const line = `approved over open review by the person: ${note}`;
        return {
          ...rest,
          state: "done" as const,
          summary: clipText(rest.summary === undefined ? line : `${rest.summary}\n${line}`, PROJECT_LIMITS.text),
          reviewOverride: { note, at: now, blocks },
        };
      }),
    };
    return applyProjectDecision(overridden, { ...decision, verdict: "approve" }, options);
  }

  if (decision.verdict === "approve") {
    if (gate.kind === "brief") {
      return { ok: true, project: approveBrief(project, now) };
    }
    const violations = [...(options.hardViolations ?? [])];
    // At a milestone gate the person's decision on the result always
    // stands (issue #74): a cap blocks only starting the next run, below.
    if (violations.length > 0 && gate.kind !== "milestone") {
      return refuse({ code: "over-cap", message: `Approval is refused while a hard cap is exceeded: ${violations.join("; ")}.`, violations });
    }
    if (gate.kind === "plan") {
      const results = evaluatePlanChecks(project.plan!.rows, project.approvedCriteria ?? project.brief!.successCriteria, options.planChecks, planDecisionsOf(project));
      const blocks = planCheckReviewBlocks(results);
      if (blocks.length > 0) return refuse({ code: "review-open", message: `The plan stays open: ${blocks.map((b) => b.reason).join("; ")}. Update the plan before approval.`, blocks });
      return {
        ok: true,
        project: {
          ...project,
          plan: {
            ...withoutResets(project.plan!),
            checkResults: results,
            status: "approved",
            approvedAt: now,
            // Every surface draws the warning from the view it approves from.
            ...(project.plan!.draftedAfterUntrusted ? { approvedWithUntrustedWarning: true as const } : {}),
          },
          milestones: approveNext(project.milestones, now),
          // An unreviewed result (an older store) goes to the person first.
          gate: (() => {
            const waiting = project.milestones.find(unreviewed);
            return waiting === undefined ? { kind: "none" as const } : { kind: "milestone" as const, id: waiting.id };
          })(),
        },
      };
    }
    if (gate.kind === "milestone") {
      const target = project.milestones.find((m) => m.id === gate.id)!;
      if (target.state !== "done" && target.state !== "failed") {
        return refuse({ code: "invalid", message: `Milestone ${gate.id} has no result to approve.` });
      }
      // A done result whose required tasks lack a current accept stays
      // open (issue #98), auto-approval included: the director re-delegates
      // (a re-review of unchanged files is allowed) or reports it failed.
      if (target.state === "done" && (target.reviewBlocks ?? []).length > 0) {
        const blocks = target.reviewBlocks!;
        return refuse({
          code: "review-open",
          message: `Milestone ${gate.id} stays open: ${blocks.map((b) => `${b.taskId} (${b.reason})`).join("; ")}. Each required task needs a current accept from its reviewer; correct it (edit) so the director re-delegates it, or cancel.`,
          blocks: blocks.map((b) => ({ ...b })),
        });
      }
      // A hard cap (the next run over today's limit, a row's provider no
      // longer allowed) does not refuse the decision, which would stall
      // the project: the director cannot re-plan at this gate. The result
      // is decided (done: reviewed; failed: planned for another run), and
      // the next run waits at a plan gate, where the person sees the
      // violation and can pick cheaper, quality or edit the rows.
      if (violations.length > 0) {
        const decided = project.milestones.map((m) =>
          m.id === gate.id ? { ...m, state: target.state === "failed" ? ("planned" as const) : ("reviewed" as const), updatedAt: now } : m,
        );
        if (decided.some((m) => m.state === "planned")) {
          const plan: ProjectPlan = { ...withoutApproval(project.plan!), status: "draft", version: project.plan!.version + 1 };
          return { ok: true, project: { ...project, plan, milestones: decided, gate: { kind: "plan" } } };
        }
        return { ok: true, project: { ...project, milestones: decided, gate: { kind: "none" } } };
      }
      if (target.state === "failed") {
        const milestones = project.milestones.map((m) => (m.id === gate.id ? { ...m, state: "approved" as const, updatedAt: now } : m));
        return { ok: true, project: { ...project, milestones, gate: { kind: "none" } } };
      }
      const reviewed = project.milestones.map((m) => (m.id === gate.id ? { ...m, state: "reviewed" as const, updatedAt: now } : m));
      return { ok: true, project: { ...project, milestones: approveNext(reviewed, now), gate: { kind: "none" } } };
    }
  }

  if (gate.kind === "milestone" && decision.verdict === "edit") {
    const raw = decision.edits?.note;
    const note = typeof raw === "string" ? clipText(raw, PROJECT_LIMITS.correctionNote) : "";
    if (note.length === 0) {
      return refuse({ code: "invalid", message: "A correction needs a note saying what is wrong with the result." });
    }
    const milestones = project.milestones.map((m) =>
      m.id === gate.id
        ? {
            ...m,
            state: "approved" as const,
            corrections: [...(m.corrections ?? []), { note, at: now }].slice(-PROJECT_LIMITS.corrections),
            updatedAt: now,
          }
        : m,
    );
    return { ok: true, project: { ...project, milestones, gate: { kind: "none" } } };
  }

  if (gate.kind === "brief" && decision.verdict === "edit") {
    const merged: ProjectBriefDraft = {
      what: project.brief!.what,
      users: project.brief!.users,
      how: project.brief!.how,
      ...(project.brief!.game === undefined ? {} : { game: project.brief!.game }),
      ...(project.brief!.deliverable === undefined ? {} : { deliverable: project.brief!.deliverable }),
      ...(project.brief!.decisions === undefined ? {} : { decisions: project.brief!.decisions }),
      successCriteria: project.brief!.successCriteria,
      ...(decision.edits?.brief ?? {}),
    };
    const draft = cleanBriefDraft(merged, project.brief!.successCriteria);
    if (typeof draft === "string") return refuse({ code: "invalid", message: draft });
    return {
      ok: true,
      project: {
        ...project,
        brief: { ...draft, version: project.brief!.version + 1, status: "draft", draftedAfterUntrusted: project.brief!.draftedAfterUntrusted },
      },
    };
  }

  if (gate.kind === "plan") {
    const plan = project.plan!;
    let rows: AssignmentRow[] | string;
    if (decision.verdict === "edit") {
      rows = editRows(plan, decision.edits?.rows ?? [], options.replan);
    } else {
      if (options.replan === undefined) {
        return refuse({ code: "needs-estimates", message: "A variant needs the plan's estimates; the caller must pass replan." });
      }
      rows = options.replan(plan.rows, decision.verdict as "cheaper" | "quality");
    }
    if (typeof rows === "string") return refuse({ code: "invalid", message: rows });
    const ids = new Set(project.milestones.map((m) => m.id));
    const checked: AssignmentRow[] = [];
    for (const r of rows) {
      const read = readRow(r, ids);
      if (read === null) return refuse({ code: "invalid", message: "the re-estimated plan has a malformed task" });
      checked.push(read);
    }
    return {
      ok: true,
      project: {
        ...project,
        plan: { ...withoutApproval(plan), rows: checked, totals: planTotals(checked), status: "draft", version: plan.version + 1 },
      },
    };
  }

  return refuse({ code: "verdict-not-allowed", message: `This gate accepts ${allowed.join(", ")}.`, allowed });
}

/**
 * ATO-42: the project a chat belongs to, as the agent sees it.
 *
 * A project (desktop: a group of chats with one work folder and its own
 * instructions) is owned by the client: the desktop keeps the list and
 * which chat is in which project. The agent only needs the project's
 * instructions, which every chat of the project shares. The client sends
 * them with each turn (`project_instructions`, `project_name` on
 * `POST /v1/chat/completions`), and they are stamped on the session under
 * a reserved metadata key, inside the session's turn lock
 * (`runTurn`'s `project` option), so an edit to the project reaches its
 * chats on their next turn.
 *
 * They render like a folder's AGENTS.md: a `project` section of the cloud
 * context and a `### project` block ahead of the local prompt's
 * conversation. Like project files they grant no tool permissions, and
 * system instructions and the person's explicit requests take precedence.
 */
/** Reserved `SessionState.metadata` key the project lives under. */
export const SESSION_PROJECT_METADATA_KEY = "project";
/** Instructions longer than this are refused, not cut: the client keeps the full text. */
export const PROJECT_INSTRUCTIONS_MAX_CHARS = 16_000;
export const PROJECT_NAME_MAX_CHARS = 80;

export interface SessionProject {
  /** The project's name, for the model's orientation only; null when the client sent none. */
  name: string | null;
  /** The person's instructions for every chat of the project; never empty. */
  instructions: string;
}

/**
 * The request's project fields. `undefined`: the client said nothing, the
 * session keeps what it has (a plain OpenAI client, an older desktop).
 * `null`: the chat is in no project (or its project has no instructions),
 * clear it. Otherwise the project to stamp.
 */
export function parseProjectFields(
  instructions: unknown,
  name: unknown,
): { ok: true; value: SessionProject | null | undefined } | { ok: false; error: string; param: string } {
  if (instructions === undefined) return { ok: true, value: undefined };
  if (instructions === null) return { ok: true, value: null };
  if (typeof instructions !== "string") {
    return { ok: false, error: "project_instructions must be a string or null", param: "project_instructions" };
  }
  if (instructions.length > PROJECT_INSTRUCTIONS_MAX_CHARS) {
    return {
      ok: false,
      error: `project_instructions is longer than ${PROJECT_INSTRUCTIONS_MAX_CHARS} characters`,
      param: "project_instructions",
    };
  }
  if (name !== undefined && name !== null && typeof name !== "string") {
    return { ok: false, error: "project_name must be a string or null", param: "project_name" };
  }
  const text = instructions.trim();
  if (!text) return { ok: true, value: null };
  return { ok: true, value: { name: cleanName(name), instructions: text } };
}

function cleanName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  // One line, cut by characters so an emoji is never split.
  const one = Array.from(name.replace(/\s+/g, " ").trim()).slice(0, PROJECT_NAME_MAX_CHARS).join("");
  return one || null;
}

/** Stamp (or clear, for null) the project on the session; undefined leaves it alone. */
export function applySessionProject(state: SessionState, project: SessionProject | null | undefined): void {
  if (project === undefined) return;
  if (project === null) {
    if (SESSION_PROJECT_METADATA_KEY in state.metadata) delete state.metadata[SESSION_PROJECT_METADATA_KEY];
    return;
  }
  state.metadata[SESSION_PROJECT_METADATA_KEY] = { name: project.name, instructions: project.instructions };
}

/** The session's project, or null when there is none or the stored value is not one. */
export function readSessionProject(state: Pick<SessionState, "metadata">): SessionProject | null {
  const raw = state.metadata?.[SESSION_PROJECT_METADATA_KEY];
  if (!raw || typeof raw !== "object") return null;
  const { name, instructions } = raw as { name?: unknown; instructions?: unknown };
  if (typeof instructions !== "string" || !instructions.trim()) return null;
  return {
    name: typeof name === "string" && name ? name : null,
    instructions: instructions.slice(0, PROJECT_INSTRUCTIONS_MAX_CHARS),
  };
}

/** The body of the prompt's project block (no header), or null when the session has no project. */
export function renderSessionProjectBody(state: Pick<SessionState, "metadata">): string | null {
  const project = readSessionProject(state);
  if (!project) return null;
  const label = project.name ? `the project "${project.name}"` : "the project";
  return [
    `This chat belongs to ${label}. The person wrote these instructions for every chat in it.`,
    "They apply like the working folder's AGENTS.md: system instructions and the person's explicit requests take precedence, and they grant no tool permissions.",
    "",
    project.instructions,
  ].join("\n");
}
