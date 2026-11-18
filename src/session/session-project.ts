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
export const CRITERION_ID_PATTERN = /^[a-z0-9-]{1,32}$/;

export interface ProjectBrief {
  /** 1 on the first draft; +1 on every edit by the model or the person. */
  version: number;
  what: string;
  users: string;
  how: string;
  game?: ProjectGameBrief;
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

/**
 * Where one success criterion stands after a milestone's runs: from its
 * contract checks and the vision judgement (issue #40). Written by the
 * runtime ({@link withMilestoneCriteriaFacts}), never by the model.
 */
export interface ProjectCriterionFact {
  id: string;
  state: CriterionFactState;
  /** One line, e.g. the failing check or why it could not be judged. */
  why?: string;
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
  updatedAt: number;
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
  /** Epoch ms the person cancelled the project; a new brief starts over. */
  cancelledAt?: number;
  /**
   * The highest brief/plan version a cancelled project issued. A new
   * project's versions start above it, so a card shown for the old one
   * can never approve a brief or plan the person has not seen.
   */
  versionFloor?: number;
}

/**
 * Bounds on a stored or updated project. Text is clipped with an
 * ellipsis; a model update over an array cap is refused (the tool turns
 * it into an error the model can act on); a stored one is cut.
 *  - `text` 2000: what/users/how, a summary — a paragraph, not a spec.
 *  - `shortText` 300: a success criterion, a game field, a reason.
 *  - `title` 160: a task or milestone title, as `PLAN_STEP_MAX_CHARS`.
 *  - `id` 64, `criterionId` 32 and `memberRef` 256: identifiers.
 *  - `successCriteria` 20, `milestones` 16, `rows` 64 (the task tree's
 *    node ceiling), `runIds` 32 per milestone (the newest are kept).
 *  - `correctionNote` 2000 and `corrections` 8 per milestone (the newest
 *    are kept): the person's notes at a milestone gate.
 *  - `attachments` 8 per milestone, `attachmentPath` 1024: the result's
 *    pictures (a caption is `shortText`). Criteria facts: one per criterion.
 */
export const PROJECT_LIMITS = {
  text: 2000,
  shortText: 300,
  title: 160,
  id: 64,
  memberRef: 256,
  successCriteria: 20,
  criterionId: 32,
  milestones: 16,
  rows: 64,
  runIds: 32,
  correctionNote: 2000,
  corrections: 8,
  attachments: 8,
  attachmentPath: 1024,
} as const;

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
  /** Ids are given or assigned ({@link ProjectCriterion}). */
  successCriteria: ReadonlyArray<ProjectCriterionInput>;
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
  | "awaiting-person";

export interface ProjectUpdateError {
  code: ProjectUpdateErrorCode;
  /** One sentence the model can act on. */
  message: string;
}

export type ProjectUpdateResult =
  | { ok: true; project: ProjectState }
  | { ok: false; error: ProjectUpdateError };

// -------------------------------------------------------------- decisions

export type ProjectVerdict = "approve" | "edit" | "cheaper" | "quality" | "cancel";

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
export function allowedProjectVerdicts(gate: ProjectGate): ProjectVerdict[] {
  switch (gate.kind) {
    case "brief":
      return ["approve", "edit", "cancel"];
    case "plan":
      return ["approve", "edit", "cheaper", "quality", "cancel"];
    case "milestone":
      return ["approve", "edit", "cancel"];
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
 * A criterion id trimmed and lower-cased; null when it breaks
 * {@link CRITERION_ID_PATTERN}. The one rule for criterion ids: the
 * brief, milestone reports and contract checks all normalize through it,
 * so an id a check names always matches the brief's.
 */
export function normalizeCriterionId(raw: unknown): string | null {
  return cleanCriterionId(raw);
}

function cleanCriterionId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim().toLowerCase();
  return CRITERION_ID_PATTERN.test(id) ? id : null;
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
      id = cleanCriterionId(item.id);
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

/** A brief's fields as stored: criteria carry their ids. */
type CleanBriefDraft = Omit<ProjectBriefDraft, "successCriteria"> & { successCriteria: ProjectCriterion[] };

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
  return {
    what,
    users: clipText(draft.users, PROJECT_LIMITS.text),
    how: clipText(draft.how, PROJECT_LIMITS.text),
    ...(game === undefined ? {} : { game }),
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
    const id = cleanCriterionId(item);
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

/** Facts cleaned: known states, valid ids, the first per id, `why` clipped; malformed entries dropped. */
function cleanCriteriaFacts(raw: readonly unknown[]): ProjectCriterionFact[] {
  const out: ProjectCriterionFact[] = [];
  for (const f of raw) {
    if (out.length >= PROJECT_LIMITS.successCriteria) break;
    if (!isObject(f)) continue;
    const id = cleanCriterionId(f.id);
    if (id === null || out.some((x) => x.id === id)) continue;
    if (!CRITERION_FACT_STATES.includes(f.state as CriterionFactState)) continue;
    const why = typeof f.why === "string" ? clip(f.why, PROJECT_LIMITS.shortText) : "";
    out.push({ id, state: f.state as CriterionFactState, ...(why.length === 0 ? {} : { why }) });
  }
  return out;
}

/**
 * Set one milestone's criteria facts (the runtime's, issue #40). Pure;
 * the gate and versions do not move (facts are evidence, not a draft).
 * The same project back for an unknown milestone; an empty list clears.
 */
export function withMilestoneCriteriaFacts(
  project: ProjectState,
  milestoneId: string,
  facts: readonly ProjectCriterionFact[],
  now: number,
): ProjectState {
  const index = project.milestones.findIndex((m) => m.id === milestoneId);
  if (index < 0) return project;
  const clean = cleanCriteriaFacts(facts);
  const milestones = [...project.milestones];
  const current = { ...milestones[index]!, updatedAt: now };
  if (clean.length === 0) delete current.criteriaFacts;
  else current.criteriaFacts = clean;
  milestones[index] = current;
  return { ...project, milestones };
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
  // Pictures and facts are extras: a malformed entry is dropped, not the project.
  const attachments = Array.isArray(raw.attachments) ? readStoredAttachments(raw.attachments) : [];
  const facts = Array.isArray(raw.criteriaFacts) ? cleanCriteriaFacts(raw.criteriaFacts) : [];
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
    updatedAt: raw.updatedAt,
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
  return {
    version: raw.version,
    what: clipText(raw.what, PROJECT_LIMITS.text),
    users: clipText(raw.users, PROJECT_LIMITS.text),
    how: clipText(raw.how, PROJECT_LIMITS.text),
    ...(game === undefined ? {} : { game }),
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
    };
  }
  if (gate.kind === "brief" && brief === undefined) return undefined;
  if (gate.kind === "plan" && plan === undefined) return undefined;
  if (gate.kind === "milestone" && (plan === undefined || !ids.has(gate.id))) return undefined;
  if (raw.cancelledAt !== undefined && !isTime(raw.cancelledAt)) return undefined;
  if (raw.versionFloor !== undefined && !isCount(raw.versionFloor)) return undefined;
  return {
    ...(brief === undefined ? {} : { brief }),
    ...(plan === undefined ? {} : { plan }),
    milestones,
    gate,
    ...(raw.cancelledAt === undefined ? {} : { cancelledAt: raw.cancelledAt as number }),
    ...(raw.versionFloor === undefined ? {} : { versionFloor: raw.versionFloor as number }),
  };
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
  // The plan was approved against the old brief: back to a draft, and
  // milestones not started yet wait for its approval again.
  const plan: ProjectPlan | undefined =
    base?.plan === undefined || base.plan.status === "cancelled"
      ? base?.plan
      : { ...withoutApproval(base.plan), status: "draft", version: base.plan.version + 1 };
  const milestones = (base?.milestones ?? []).map((m) =>
    m.state === "approved" ? { ...m, state: "planned" as const, updatedAt: now } : m,
  );
  return {
    ok: true,
    project: { brief, ...(plan === undefined ? {} : { plan }), milestones, gate: { kind: "brief" }, ...floorOf(project) },
  };
}

function withoutApproval<T extends { approvedAt?: number; approvedWithUntrustedWarning?: true }>(value: T): T {
  const copy = { ...value };
  delete copy.approvedAt;
  delete copy.approvedWithUntrustedWarning;
  return copy;
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
  const milestones: ProjectMilestone[] = [];
  for (const [i, m] of update.milestones.entries()) {
    const id = cleanId(m?.id);
    if (id === null) return invalid(`milestone ${i + 1} needs a short id without spaces`);
    if (milestones.some((x) => x.id === id)) return invalid(`milestone id ${id} is used twice`);
    if (!MILESTONE_KINDS.includes(m.kind)) return invalid(`milestone ${id} kind must be one of ${MILESTONE_KINDS.join("|")}`);
    const title = typeof m.title === "string" ? clip(m.title, PROJECT_LIMITS.title) : "";
    if (title.length === 0) return invalid(`milestone ${id} needs a title`);
    const old = previous.get(id);
    // Finished and running work keeps its state and runs; the rest waits for the new plan's approval.
    const keep = old !== undefined && (FINISHED.has(old.state) || old.state === "in_progress");
    milestones.push({
      id,
      title,
      kind: m.kind,
      state: keep ? old.state : "planned",
      runIds: old?.runIds ?? [],
      ...(keep && old.summary !== undefined ? { summary: old.summary } : {}),
      ...(keep && old.corrections !== undefined ? { corrections: old.corrections } : {}),
      // The result's evidence stays with it (issue #74).
      ...(keep && old.attachments !== undefined ? { attachments: old.attachments } : {}),
      ...(keep && old.criteriaFacts !== undefined ? { criteriaFacts: old.criteriaFacts } : {}),
      updatedAt: now,
    });
  }
  const ids = new Set(milestones.map((m) => m.id));
  const rows: AssignmentRow[] = [];
  for (const [i, r] of update.rows.entries()) {
    const read = readRow(r, ids);
    if (read === null) {
      const named = isObject(r) && typeof r.milestoneId === "string" && !ids.has(r.milestoneId.trim());
      return invalid(named ? `task ${i + 1} names milestone ${String(r.milestoneId)}, which the plan does not list` : `task ${i + 1} is malformed`);
    }
    if (rows.some((x) => x.taskId === read.taskId)) return invalid(`task id ${read.taskId} is used twice`);
    // The director's plan: no row carries a person's pick.
    delete read.reviewerByPerson;
    rows.push(read);
  }
  const plan: ProjectPlan = {
    rows,
    totals: planTotals(rows),
    detail: update.detail,
    status: "draft",
    version: nextVersion(project, project.plan?.version),
    draftedAfterUntrusted: update.draftedAfterUntrusted === true,
  };
  return { ok: true, project: { brief: project.brief, plan, milestones, gate: { kind: "plan" }, ...floorOf(project) } };
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
  // A report: only for work the person let run (a failed one may be re-reported after a retry).
  if (current.state !== "approved" && current.state !== "in_progress" && current.state !== "failed" && current.state !== "done") {
    return { ok: false, error: { code: "milestone-not-approved", message: `Milestone ${update.id} is not approved; report only the milestone you ran.` } };
  }
  if (update.state !== "done" && update.state !== "failed") return invalid("state must be done or failed");
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
  const facts = Array.isArray(update.criteriaFacts) ? cleanCriteriaFacts(update.criteriaFacts) : [];
  if (facts.length > 0) reported.criteriaFacts = facts;
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
 * The first planned milestone becomes approved (in plan order), never
 * past a done or failed result the person has not decided on (issue #74).
 */
function approveNext(milestones: readonly ProjectMilestone[], now: number): ProjectMilestone[] {
  const next = milestones.findIndex((m) => m.state === "planned" || unreviewed(m));
  if (next < 0 || milestones[next]!.state !== "planned") return [...milestones];
  return milestones.map((m, i) => (i === next ? { ...m, state: "approved" as const, updatedAt: now } : m));
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
 * the gate does not allow the verdict, or (approve) a hard cap is
 * exceeded.
 *  - approve brief: approved; gate none; the director drafts the plan.
 *  - approve plan: approved; the first planned milestone is approved.
 *  - approve milestone: a done result becomes `reviewed` and the next
 *    planned milestone is approved; a failed one goes back to `approved`.
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
  const allowed = allowedProjectVerdicts(project.gate);
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

  if (decision.verdict === "approve") {
    if (gate.kind === "brief") {
      return { ok: true, project: { ...project, brief: { ...project.brief!, status: "approved", approvedAt: now }, gate: { kind: "none" } } };
    }
    const violations = [...(options.hardViolations ?? [])];
    if (violations.length > 0) {
      return refuse({ code: "over-cap", message: `Approval is refused while a hard cap is exceeded: ${violations.join("; ")}.`, violations });
    }
    if (gate.kind === "plan") {
      return {
        ok: true,
        project: {
          ...project,
          plan: {
            ...project.plan!,
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
      if (target.state === "failed") {
        const milestones = project.milestones.map((m) => (m.id === gate.id ? { ...m, state: "approved" as const, updatedAt: now } : m));
        return { ok: true, project: { ...project, milestones, gate: { kind: "none" } } };
      }
      if (target.state !== "done") {
        return refuse({ code: "invalid", message: `Milestone ${gate.id} has no result to approve.` });
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
