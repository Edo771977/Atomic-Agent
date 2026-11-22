import { criterionBasisLabel, criterionBasisSummaryLine, directorReportWarningLine, directorReportWarnings, summarizeCriterionBases } from "../../session/project-gate-text.js";
import { compressToolResult, type CompressedToolResult } from "../../compressor/result-compressor.js";
import type { UserFusionProjectConfig } from "../../config/llm-run-mode-config.js";
import { sameMember } from "./member-identity.js";
import type { TeamMember } from "../../llm/run-mode/fusion-team.js";
import {
  CRITERION_ID_PATTERN,
  MILESTONE_KINDS,
  PROJECT_LIMITS,
  PROJECT_DELIVERABLES,
  activeDecisionsOf,
  applyProjectUpdate,
  finishedCitationsOf,
  normalizeCriterionId,
  backlogCheckOptions,
  planDecisionsOf,
  planReviewPersonCalls,
  planTotals,
  projectVerdictResets,
  storedPlanRow,
  type AssignmentRow,
  type MilestoneKind,
  type ProjectBriefDraft,
  type ProjectDeliverable,
  type ProjectBriefDecision,
  type ProjectCriterion,
  type ProjectCriterionInput,
  type ProjectMilestone,
  type ProjectMilestoneAttachment,
  type ProjectGameBrief,
  type ProjectState,
  type ProjectUpdate,
} from "../../session/session-project.js";
import { openBacklog, openSeeds, promotedForPlan } from "../../session/project-backlog.js";
import { backlogDataBlock } from "../../prompt/project-digest.js";
import type { ToolDefinition } from "../tool-registry.js";
import type { OutcomeRecord } from "./outcome-log.js";
import { estimateRow, planDetailFor, withReviewEstimate } from "./project-estimate.js";
import { verdictResetHint } from "./project-gate-view.js";
import { isTooBroadScope, tooBroadWorkdirMessage } from "./scope-path.js";
import type { WorkerPricing } from "./worker-result.js";
import type { MilestoneEvidence } from "./run-criteria.js";
import type { ContractCheck } from "./contract.js";
import { parsePlanRowChecks } from "./contract-check-spec.js";
import { evaluatePlanChecks, planCheckHint, planReferenceBasis, type PlanReferenceRecord } from "./plan-checks.js";
import { DEFAULT_FUSION_TEAM_PLAN_REVIEW_ROUNDS } from "../../config/llm-fusion-team-config.js";
import { frameUntrustedText } from "../untrusted-tool-output.js";
import { planReviewBasis, planReviewCallsBasis, planReviewHints, planReviewPromptLine, withPlanFacts, type PlanReviewFacts, type PlanReviewRecord } from "./plan-review-record.js";
import type { PlanReviewFn } from "./plan-reviewer.js";

/**
 * The director's project tools (issue #39): `project.brief`,
 * `project.plan`, `project.milestone`. Each validates its arguments and
 * hands a {@link ProjectUpdate} back in `details.projectUpdate`; the step
 * commit folds it into `SessionState.project` through
 * `applyProjectUpdate` (which refuses an update the project's state does
 * not allow, and that refusal becomes this call's error). Nothing here
 * approves: the person decides at the gate between turns
 * (`runtime.projectDecision`).
 *
 * Read-only like `plan.update`: they change only the session's own
 * record, so plan mode and the fusion orchestrator gate admit them, and
 * they read no file and send nothing out.
 */

export const PROJECT_BRIEF_TOOL = "project.brief";
export const PROJECT_PLAN_TOOL = "project.plan";
export const PROJECT_MILESTONE_TOOL = "project.milestone";
/** Issue #111: the director's backlog proposals (`project-backlog-tool.ts`). */
export const PROJECT_BACKLOG_ADD_TOOL = "project.backlog.add";
/** In catalog order. */
export const PROJECT_TOOL_NAMES = [PROJECT_BRIEF_TOOL, PROJECT_PLAN_TOOL, PROJECT_MILESTONE_TOOL, PROJECT_BACKLOG_ADD_TOOL] as const;

/** Key of the update in the result's `details`, read by `applyStateEffects`. */
export const PROJECT_UPDATE_DETAIL = "projectUpdate";

/**
 * What `project.plan` assigns and estimates with, read per call from the
 * live team, policy and history (the runtime builds it).
 */
export interface ProjectPlanContext {
  /** Workers a task may be given: the team's, filtered by the folder's policy and reachability; without a team, the worker leg. */
  workers: readonly TeamMember[];
  /** Reviewers a task may name (same filters). */
  reviewers: readonly TeamMember[];
  /** The worker of a task that names none; null: none can serve. */
  defaultWorker: TeamMember | null;
  /** The reviewer the team picks for a worker (`pickReviewer`); null: none. */
  reviewerFor: (worker: TeamMember) => TeamMember | null;
  /** Whether tasks get a review at all (`reviewEnabled`). */
  reviewOn: boolean;
  /** Why review is off for this run, for the director; absent while it is on. */
  reviewOffReason?: string;
  /** The outcome log's rows (`readRoutingHistory`). */
  records: readonly OutcomeRecord[];
  pricing: (member: TeamMember) => WorkerPricing | undefined;
  /** A local member's measured speed; null for a cloud one or before any measurement. */
  tokensPerSecond: (member: TeamMember) => number | null;
  /** Whether the member runs on a local server: its tasks are priced at $0 (issue #54). Absent: none is. */
  isLocal?: (member: TeamMember) => boolean;
  /** `measuredRouting.minSamples` / `.days`. */
  minSamples: number;
  days: number;
  now?: number;
  /** `llm.runMode.fusion.project`: the plan's default detail. */
  projectConfig?: UserFusionProjectConfig;
}

export interface ProjectToolDeps {
  planContext: () => ProjectPlanContext;
  /** Whether the session read outside content this turn (the approval gate's taint). */
  outsideContent: (sessionId: string) => boolean;
  /**
   * A milestone's evidence from its runs (issue #40, `run-criteria.ts`):
   * the criteria facts its checks and the vision judge established, and
   * its screenshots, newest first. A done report carries the facts, and
   * the screenshots when it names no attachments. Absent: neither.
   */
  /**
   * Whether the session's turn still has budget for a correction round
   * (issue #100); absent: assumed so. Out of budget, the director may
   * report the milestone failed at once (it stays open at the gate).
   */
  correctionBudgetLeft?: (sessionId: string) => boolean;
  /**
   * Issue #120: resolve the drafted rows' cited files, scripts, commands
   * and symbols in the project folder (`plan-references.ts`); never runs
   * a project command. Absent: the plan has no `references` result.
   */
  planReferences?: (rows: readonly AssignmentRow[], projectFolder: string, signal: AbortSignal | undefined) => Promise<PlanReferenceRecord>;
  /**
   * Issue #118: the plan reviewer (`plan-reviewer.ts`'s `createPlanReview`),
   * asked once per draft before the plan gate reaches the person; it
   * returns null when no plan reviewer is configured. Absent: no review.
   */
  planReview?: PlanReviewFn;
  /** `team.planReviewRounds`: how often a failed draft goes back to the director; absent: the default (2). */
  planReviewRounds?: () => number;
  milestoneEvidence?: (
    milestone: ProjectMilestone,
    criteriaOrder: readonly string[],
    /** The approved brief's criteria and approval time: run facts count only for the text they tested (issue #87). */
    current: { criteria: readonly ProjectCriterion[]; briefApprovals?: number; requiredTasks?: readonly string[] },
  ) => MilestoneEvidence;
}

type Parsed<T> = { ok: true } & T | { ok: false; problems: string[] };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

function unknownKeys(raw: Record<string, unknown>, allowed: readonly string[], where: string): string[] {
  return Object.keys(raw).filter((k) => !allowed.includes(k)).map((k) => `${where}: unknown key \`${k}\``);
}

// ------------------------------------------------------------------ brief

/** Each criterion is a sentence, or `{ id, text }` with a unique `[a-z0-9-]` id of at most 32 characters. */
function criteriaProblems(criteria: readonly unknown[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const [i, c] of criteria.entries()) {
    if (nonEmpty(c)) continue;
    if (!isObject(c) || !nonEmpty(c.text) || typeof c.id !== "string") {
      problems.push(`\`successCriteria\` ${i + 1} must be a short checkable sentence, or { id, text }`);
      continue;
    }
    const extra = Object.keys(c).filter((k) => k !== "id" && k !== "text");
    if (extra.length > 0) problems.push(`\`successCriteria\` ${i + 1}: unknown key \`${extra[0]}\``);
    const id = c.id.trim().toLowerCase();
    if (!CRITERION_ID_PATTERN.test(id)) {
      problems.push(`\`successCriteria\` ${i + 1}: id ${JSON.stringify(c.id)} must be 1..${PROJECT_LIMITS.criterionId} characters of a-z, 0-9 and -`);
    } else if (seen.has(id)) {
      problems.push(`\`successCriteria\`: id ${id} is used twice`);
    }
    seen.add(id);
  }
  return problems;
}

export function parseProjectBriefArgs(raw: Record<string, unknown>): Parsed<{ brief: ProjectBriefDraft }> {
  const problems: string[] = unknownKeys(raw, ["what", "users", "how", "game", "successCriteria", "deliverable", "decisions"], "project.brief");
  if (raw.deliverable !== undefined && !PROJECT_DELIVERABLES.includes(raw.deliverable as ProjectDeliverable)) problems.push("`deliverable` must be code, document, spreadsheet, research, files or game");
  if (raw.decisions !== undefined) {
    if (!Array.isArray(raw.decisions) || raw.decisions.length > PROJECT_LIMITS.decisions) problems.push(`decisions must list at most ${PROJECT_LIMITS.decisions} { id, text } entries`);
    else {
      if (raw.decisions.some((d) => !isObject(d))) problems.push("decisions must contain { id, text } objects");
      problems.push(...criteriaProblems(raw.decisions).map((p) => p.replaceAll("successCriteria", "decisions")));
    }
  }
  if (!nonEmpty(raw.what)) problems.push("`what` must say what is being built");
  for (const f of ["users", "how"] as const) {
    if (typeof raw[f] !== "string") problems.push(`\`${f}\` must be text`);
  }
  let game: ProjectGameBrief | undefined;
  if (raw.game !== undefined) {
    const g = raw.game;
    const fields = ["rules", "loop", "difficulty", "style"] as const;
    if (!isObject(g) || !fields.every((f) => typeof g[f] === "string")) {
      problems.push("`game` must be { rules, loop, difficulty, style }, each text");
    } else {
      game = { rules: g.rules as string, loop: g.loop as string, difficulty: g.difficulty as string, style: g.style as string };
    }
  }
  const criteria = raw.successCriteria;
  if (!Array.isArray(criteria) || criteria.length === 0) {
    problems.push("`successCriteria` must be a list of short checkable sentences (at least one)");
  } else if (criteria.length > PROJECT_LIMITS.successCriteria) {
    problems.push(`\`successCriteria\`: at most ${PROJECT_LIMITS.successCriteria}`);
  } else {
    problems.push(...criteriaProblems(criteria));
  }
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    brief: {
      what: raw.what as string,
      users: raw.users as string,
      how: raw.how as string,
      ...(game === undefined ? {} : { game }),
      ...(raw.deliverable === undefined ? {} : { deliverable: raw.deliverable as ProjectDeliverable }),
      ...(raw.decisions === undefined ? {} : { decisions: raw.decisions as ProjectBriefDecision[] }),
      successCriteria: criteria as ProjectCriterionInput[],
    },
  };
}

// ------------------------------------------------------------------- plan

export interface ProjectPlanTaskArgs {
  checks?: ContractCheck[];
  decisions?: string[];
  /** Issue #146: the backlog items this task takes in. */
  backlog?: string[];
  id: string;
  title: string;
  milestone: string;
  /** A team worker, as listed or by model; absent: the default worker. */
  worker?: string;
  /** A team reviewer; null: no review; absent: the team's pick. */
  reviewer?: string | null;
}

export interface ProjectPlanArgs {
  milestones: Array<{ id: string; title: string; kind: MilestoneKind }>;
  tasks: ProjectPlanTaskArgs[];
}

const cleanId = (v: unknown): string | null =>
  typeof v === "string" && v.trim().length > 0 && v.trim().length <= PROJECT_LIMITS.id && !/\s/.test(v.trim()) ? v.trim() : null;

export function parseProjectPlanArgs(raw: Record<string, unknown>): Parsed<{ plan: ProjectPlanArgs }> {
  const problems: string[] = unknownKeys(raw, ["milestones", "tasks"], "project.plan");
  const milestones: ProjectPlanArgs["milestones"] = [];
  if (!Array.isArray(raw.milestones) || raw.milestones.length === 0) {
    problems.push("`milestones` must list at least one { id, title, kind }");
  } else if (raw.milestones.length > PROJECT_LIMITS.milestones) {
    problems.push(`\`milestones\`: at most ${PROJECT_LIMITS.milestones}`);
  } else {
    for (const [i, m] of raw.milestones.entries()) {
      const id = isObject(m) ? cleanId(m.id) : null;
      if (!isObject(m) || id === null) {
        problems.push(`milestone ${i + 1} needs a short \`id\` without spaces`);
        continue;
      }
      if (!nonEmpty(m.title)) problems.push(`milestone ${id} needs a \`title\``);
      if (!MILESTONE_KINDS.includes(m.kind as MilestoneKind)) problems.push(`milestone ${id}: \`kind\` must be one of ${MILESTONE_KINDS.join("|")}`);
      if (milestones.some((x) => x.id === id)) problems.push(`milestone id ${id} is used twice`);
      milestones.push({ id, title: String(m.title ?? ""), kind: m.kind as MilestoneKind });
    }
  }
  const ids = new Set(milestones.map((m) => m.id));
  const tasks: ProjectPlanTaskArgs[] = [];
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) {
    problems.push("`tasks` must list at least one { id, title, milestone }");
  } else if (raw.tasks.length > PROJECT_LIMITS.rows) {
    problems.push(`\`tasks\`: at most ${PROJECT_LIMITS.rows}; merge small tasks`);
  } else {
    for (const [i, t] of raw.tasks.entries()) {
      const id = isObject(t) ? cleanId(t.id) : null;
      if (!isObject(t) || id === null) {
        problems.push(`task ${i + 1} needs a short \`id\` without spaces (the id its fusion.delegate task will carry)`);
        continue;
      }
      problems.push(...unknownKeys(t, ["id", "title", "milestone", "worker", "reviewer", "checks", "decisions", "backlog"], `task ${id}`));
      const checkProblems: string[] = [];
      const checks = parsePlanRowChecks(t.checks, id, checkProblems);
      problems.push(...checkProblems.map((p) => `task ${id}: ${p}`));
      const decisions = Array.isArray(t.decisions) ? t.decisions.map(normalizeCriterionId) : [];
      if (t.decisions !== undefined && (!Array.isArray(t.decisions) || decisions.length > PROJECT_LIMITS.decisions || decisions.includes(null) || new Set(decisions).size !== decisions.length)) problems.push(`task ${id}: decisions must be unique decision ids (at most ${PROJECT_LIMITS.decisions})`);
      const backlog = Array.isArray(t.backlog) ? t.backlog.map(normalizeCriterionId) : [];
      if (t.backlog !== undefined && (!Array.isArray(t.backlog) || backlog.length > PROJECT_LIMITS.backlog || backlog.includes(null) || new Set(backlog).size !== backlog.length)) problems.push(`task ${id}: backlog must be unique backlog item ids (at most ${PROJECT_LIMITS.backlog})`);
      if (!nonEmpty(t.title)) problems.push(`task ${id} needs a \`title\``);
      const milestone = typeof t.milestone === "string" ? t.milestone.trim() : "";
      if (!ids.has(milestone)) problems.push(`task ${id} names milestone ${JSON.stringify(t.milestone)}, which \`milestones\` does not list`);
      if (t.worker !== undefined && !nonEmpty(t.worker)) problems.push(`task ${id}: \`worker\` must name a team worker`);
      if (t.reviewer !== undefined && t.reviewer !== null && !nonEmpty(t.reviewer)) problems.push(`task ${id}: \`reviewer\` must name a team reviewer, or be null`);
      if (tasks.some((x) => x.id === id)) problems.push(`task id ${id} is used twice`);
      tasks.push({
        id,
        title: String(t.title ?? ""),
        milestone,
        ...(t.checks === undefined ? {} : { checks }),
        ...(t.decisions === undefined ? {} : { decisions: decisions as string[] }),
        ...(t.backlog === undefined ? {} : { backlog: backlog as string[] }),
        ...(typeof t.worker === "string" ? { worker: t.worker.trim() } : {}),
        ...(t.reviewer === null ? { reviewer: null } : typeof t.reviewer === "string" ? { reviewer: t.reviewer.trim() } : {}),
      });
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, plan: { milestones, tasks } };
}

/** A member by ref, else by model alone when that is unambiguous. */
function findMember(members: readonly TeamMember[], name: string): TeamMember | undefined {
  const exact = members.find((m) => m.ref === name);
  if (exact !== undefined) return exact;
  // By identity (issue #98): `codex-cli`, `codex-cli:` and `codex-cli:default` are one member.
  const same = members.filter((m) => sameMember(m.ref, name));
  if (same.length === 1) return same[0];
  const byModel = members.filter((m) => m.model === name);
  if (byModel.length === 1) return byModel[0];
  // A bare provider names its only member there; two or more stay ambiguous.
  const trimmed = name.trim();
  const bare = trimmed.endsWith(":") ? trimmed.slice(0, -1) : trimmed;
  if (bare.includes(":")) return undefined;
  const byProvider = members.filter((m) => m.providerId === bare);
  return byProvider.length === 1 ? byProvider[0] : undefined;
}

/** The plan's rows with workers, reviewers and estimates, or the problems. */
export function enrichPlanRows(plan: ProjectPlanArgs, context: ProjectPlanContext): { ok: true; rows: AssignmentRow[]; notes: string[] } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const rows: AssignmentRow[] = [];
  // A reviewer named while review is off is accepted with no review, never silently: the director must not promise one.
  const notes: string[] = [];
  const listed = (list: readonly TeamMember[]) => list.map((m) => `\`${m.ref}\``).join(", ") || "none";
  for (const task of plan.tasks) {
    let worker: TeamMember | null | undefined;
    if (task.worker !== undefined) {
      worker = findMember(context.workers, task.worker);
      if (worker === undefined) {
        problems.push(`task ${task.id}: worker ${task.worker} is not a team worker this folder can use (${listed(context.workers)})`);
        continue;
      }
    } else {
      worker = context.defaultWorker;
      if (worker === null) {
        problems.push(`task ${task.id}: no worker can serve it here; name one of ${listed(context.workers)}`);
        continue;
      }
    }
    let reviewer: TeamMember | null;
    if (!context.reviewOn) {
      reviewer = null;
      if (typeof task.reviewer === "string") {
        notes.push(`task ${task.id}: review is off for this run (${context.reviewOffReason ?? "no review is enabled"}), so ${task.reviewer} will not review it; do not tell the person it will.`);
      }
    }
    else if (task.reviewer === null) reviewer = null;
    else if (task.reviewer !== undefined) {
      const found = findMember(context.reviewers, task.reviewer);
      if (found === undefined || found.ref === worker.ref) {
        problems.push(`task ${task.id}: reviewer ${task.reviewer} is not a team reviewer this folder can use for it (${listed(context.reviewers)})`);
        continue;
      }
      reviewer = found;
    } else reviewer = context.reviewerFor(worker);
    const est = estimateRow(worker, null, context.records, context.pricing(worker), {
      minSamples: context.minSamples,
      days: context.days,
      ...(context.now === undefined ? {} : { now: context.now }),
      tokensPerSecond: context.tokensPerSecond(worker),
      local: context.isLocal?.(worker) ?? false,
    });
    const reviewEst = reviewer === null ? null : estimateRow(reviewer, "review", context.records, context.pricing(reviewer), {
      minSamples: context.minSamples,
      days: context.days,
      ...(context.now === undefined ? {} : { now: context.now }),
      tokensPerSecond: context.tokensPerSecond(reviewer),
      local: context.isLocal?.(reviewer) ?? false,
    });
    rows.push(withReviewEstimate({
      ...(task.checks === undefined ? {} : { checks: task.checks }),
      ...(task.decisions === undefined ? {} : { decisions: task.decisions }),
      ...(task.backlog === undefined ? {} : { backlog: task.backlog }),
      taskId: task.id,
      title: task.title,
      milestoneId: task.milestone,
      worker: worker.ref,
      reviewer: reviewer?.ref ?? null,
      reason: task.worker === undefined ? est.reason : `named in the plan; ${est.reason}`,
      basis: est.basis,
      samples: est.samples,
      estCostUsd: est.estCostUsd,
      estMs: est.estMs,
      ...(est.local === true ? { local: true as const } : {}),
    }, reviewEst));
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, rows, notes };
}

/**
 * The enriched rows as the store keeps them, with a note for each title
 * it shortens. A row the store would refuse stays as drafted: the fold
 * refuses it as before.
 */
function storedRows(rows: readonly AssignmentRow[], milestoneIds: readonly string[]): { rows: AssignmentRow[]; notes: string[] } {
  const ids = new Set(milestoneIds);
  const notes: string[] = [];
  const kept = rows.map((row) => {
    const stored = storedPlanRow(row, ids);
    if (stored === null) return row;
    if (stored.title !== row.title.replace(/\s+/g, " ").trim()) {
      notes.push(`task ${row.taskId}: title shortened to ${PROJECT_LIMITS.title} characters; put the details in its checks.`);
    }
    return stored;
  });
  return { rows: kept, notes };
}

// -------------------------------------------------------------- milestone

export function parseProjectMilestoneArgs(raw: Record<string, unknown>): Parsed<{ report: Extract<ProjectUpdate, { kind: "milestone" }> }> {
  const problems: string[] = unknownKeys(raw, ["id", "state", "summary", "attachments"], "project.milestone");
  const id = cleanId(raw.id);
  if (id === null) problems.push("`id` must name a milestone of the plan");
  if (raw.state !== "done" && raw.state !== "failed") problems.push('`state` must be "done" or "failed" (the person approves)');
  if (!nonEmpty(raw.summary)) problems.push("`summary` must say what the milestone produced and what is still wrong");
  // Shape only: whether a path lies in a run's shots folder is checked
  // against the milestone's runs when the report is folded.
  let attachments: ProjectMilestoneAttachment[] | undefined;
  if (raw.attachments !== undefined) {
    if (!Array.isArray(raw.attachments) || raw.attachments.length > PROJECT_LIMITS.attachments) {
      problems.push(`\`attachments\` must list at most ${PROJECT_LIMITS.attachments} { path, caption, criteria? }`);
    } else {
      attachments = [];
      for (const [i, a] of raw.attachments.entries()) {
        if (!isObject(a) || !nonEmpty(a.path) || !nonEmpty(a.caption)) {
          problems.push(`attachment ${i + 1} needs a \`path\` (a screenshot of this milestone's runs) and a \`caption\``);
          continue;
        }
        problems.push(...unknownKeys(a, ["path", "caption", "criteria"], `attachment ${i + 1}`));
        if (a.criteria !== undefined && (!Array.isArray(a.criteria) || !a.criteria.every(nonEmpty))) {
          problems.push(`attachment ${i + 1}: \`criteria\` must list success criterion ids`);
          continue;
        }
        attachments.push({ path: a.path, caption: a.caption, ...(a.criteria === undefined ? {} : { criteria: a.criteria as string[] }) });
      }
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    report: {
      kind: "milestone",
      id: id!,
      state: raw.state as "done" | "failed",
      summary: raw.summary as string,
      ...(attachments === undefined ? {} : { attachments }),
    },
  };
}

// ------------------------------------------------------------------ tools

function refuse(tool: string, problems: string[]): CompressedToolResult {
  return compressToolResult({ tool, status: "error", output: `${tool}: ${problems.join("; ")}.`, details: { field: "args" } });
}

/**
 * A project works in a project folder (issue #53): refuse before a brief
 * or plan is drafted from a root or the home folder, which fusion.delegate
 * would refuse anyway once the person had approved it.
 */
function refuseBroadWorkdir(tool: string, workingDir: string): CompressedToolResult | null {
  if (!isTooBroadScope(workingDir)) return null;
  return compressToolResult({
    tool, status: "error",
    output: tooBroadWorkdirMessage(workingDir, `${tool} did not run: a project`),
    details: { reason: "workdir-too-broad", workingDir },
  });
}

function accepted(tool: string, output: string, update: ProjectUpdate): CompressedToolResult {
  return compressToolResult(
    { tool, status: "ok", output, details: { [PROJECT_UPDATE_DETAIL]: update } },
    { maxTailLines: PROJECT_LIMITS.rows + 8, maxSummaryLength: 6_000 },
  );
}

const usd = (n: number | null): string => (n === null ? "cost unknown" : `~$${n.toFixed(2)}`);
const rowUsd = (row: AssignmentRow): string => (row.local === true ? "$0.00 (local)" : usd(row.estCostUsd));
const secs = (ms: number | null): string => (ms === null ? "time unknown" : `~${Math.max(1, Math.round(ms / 1000))}s`);

const AWAIT_PERSON = "Now reply to the person: they approve, edit or cancel it between turns. Do not delegate until it is approved.";

/**
 * Correction rounds a milestone gets after a needs-changes with concrete
 * blockers (issue #100): the director may not report it failed while one
 * is left and the turn has budget. Rounds used are the milestone's runs in
 * which a required task got needs-changes, the first not counted.
 */
export const MILESTONE_CORRECTION_ROUNDS = 2;
/** Failed reports held back for correction per milestone, at most (issue #100); the next is accepted. */
export const MILESTONE_FAILED_REFUSALS = 2;
/** A review block whose reviewer could not run or answer: a failed report then is never held back. */
const REVIEWER_DOWN = /no reviewer ran|could not run|could not be read|not judged/i;

const REVISE_FOR_REVIEW =
  "Not shown to the person yet: revise the plan with project.plan to address the plan reviewer's notes (or say in a task title why one does not apply). Do not reply to the person and do not delegate until the plan is at their gate.";

/** The reviewer's notes are a model's answer: framed as data in the director's result. */
const PLAN_REVIEWER_SOURCE = "the plan reviewer's answer (a model)";

function reviewLines(review: PlanReviewRecord, rows: readonly AssignmentRow[], milestoneIds: readonly string[], facts: PlanReviewFacts, deps: ProjectToolDeps): string[] {
  const hints = planReviewHints({ rows, review }, milestoneIds, facts);
  if (review.outcome !== "reviewed") return hints;
  const [head, ...notes] = hints;
  const results = withPlanFacts(review.results, rows, facts);
  const fails = results.filter((r) => r.verdict === "fail");
  const rounds = deps.planReviewRounds?.() ?? DEFAULT_FUSION_TEAM_PLAN_REVIEW_ROUNDS;
  return [
    review.sentBack
      ? `Plan not shown to the person: the plan reviewer failed ${fails.map((r) => r.dimension).join(", ")} (round ${review.round} of ${rounds + 1}).`
      : fails.length > 0
        ? `The plan reviewer still fails ${fails.map((r) => r.dimension).join(", ")} after ${review.round - 1} round${review.round - 1 === 1 ? "" : "s"}: the person sees its open notes at the gate and decides.`
        : head!,
    ...(notes.length === 0 ? [] : [frameUntrustedText(results.filter((r) => r.verdict !== "pass").map(planReviewPromptLine).join("\n"), PLAN_REVIEWER_SOURCE)]),
  ];
}

/**
 * Issue #118: ask the plan reviewer about this draft. The round counts
 * the reviews since a person last decided at a gate (the director
 * drafting again never restarts it); a fail sends the draft back while
 * rounds are left. Undefined: no review.
 */
async function reviewDraft(
  deps: ProjectToolDeps,
  ctx: Parameters<ToolDefinition["run"]>[1],
  draft: { update: Extract<ProjectUpdate, { kind: "plan" }>; rows: readonly AssignmentRow[]; criteria: readonly ProjectCriterion[]; planChecks: ReturnType<typeof evaluatePlanChecks> },
): Promise<PlanReviewRecord | undefined> {
  const project = ctx.project;
  if (deps.planReview === undefined || project?.brief?.status !== "approved") return undefined;
  const previous = project.plan?.review;
  // Rounds count per plan cycle: on from the last review until a person decides (issue #118).
  const continues = previous !== undefined && previous.decided !== true;
  const answer = await deps.planReview({
    ...(ctx.incognito || ctx.projectRef === undefined ? {} : { lessonSource: ctx.projectRef }),
    input: {
      brief: { what: project.brief.what, users: project.brief.users, how: project.brief.how, ...(project.brief.deliverable === undefined ? {} : { deliverable: project.brief.deliverable }) },
      criteria: draft.criteria,
      decisions: planDecisionsOf(project),
      milestones: draft.update.milestones,
      rows: draft.rows,
      planChecks: draft.planChecks,
      ...(continues ? { previousNotes: withPlanFacts(previous.results, project.plan?.rows ?? [], draft).filter((r) => r.verdict !== "pass" && r.dimension !== "lessons") } : {}),
      // Issue #111: the backlog as data; the person's promoted items are this plan's to take in.
      ...(() => {
        const backlog = [
          // Issue #146: one the person deferred at the plan gate is not this plan's to take in.
          ...promotedForPlan(project).map((b) => ({ id: b.id, title: b.title, state: project.backlogCalls?.[b.id]?.deferred === true ? "deferred" as const : "promoted" as const })),
          ...openBacklog(project).map((b) => ({ id: b.id, title: b.title, state: "open" as const, ...(b.condition === undefined ? {} : { condition: b.condition }) })),
        ];
        return backlog.length === 0 ? {} : { backlog };
      })(),
    },
    sessionId: ctx.sessionId,
    signal: ctx.signal,
  });
  if (answer === null) return undefined;
  const round = continues ? previous.round + 1 : 1;
  const rounds = deps.planReviewRounds?.() ?? DEFAULT_FUSION_TEAM_PLAN_REVIEW_ROUNDS;
  // The facts floor counts now (a criterion no check names is a fail); the record keeps the model's verdicts only.
  const sentBack = answer.outcome === "reviewed" && withPlanFacts(answer.results, draft.rows, draft).some((r) => r.verdict === "fail") && round <= rounds;
  // Issue #146: read under the person's calls as they stand; changing one at the gate makes it stale.
  return { ...answer, round, sentBack, basis: planReviewBasis(draft.rows, draft.update.milestones.map((m) => m.id)), callsBasis: planReviewCallsBasis(planReviewPersonCalls(project)) };
}

/** Issue #111: the backlog the draft should consider: promoted items to take in, open seeds to propose. */
function backlogLines(project: ProjectState | undefined): string[] {
  if (project === undefined) return [];
  const promoted = promotedForPlan(project);
  const seeds = openSeeds(project);
  const block = backlogDataBlock([
    ...promoted.map((b) => `promoted: ${b.id} ${b.title}`),
    ...seeds.map((b) => `seed: ${b.id} ${b.title} (when: ${b.condition})`),
  ]);
  if (block === null) return [];
  return [
    ...(promoted.length === 0 ? [] : ["Items the person promoted are for this plan: take each in on a task that will run and cite its id in that task's backlog; the plan cannot be approved until each is cited (or the person defers it)."]),
    ...(seeds.length === 0 ? [] : ["Open seeds are shown to the person at the gate: tell them which conditions look met; only they promote one."]),
    block,
  ];
}

export function buildProjectTools(deps: ProjectToolDeps): [ToolDefinition, ToolDefinition, ToolDefinition] {
  const brief: ToolDefinition = {
    name: PROJECT_BRIEF_TOOL,
    description: "Draft or revise the project brief (what, for whom, how, success criteria) for the person to approve.",
    readonly: true,
    async run(rawArgs, ctx) {
      const broad = refuseBroadWorkdir(PROJECT_BRIEF_TOOL, ctx.workingDir);
      if (broad !== null) return broad;
      const parsed = parseProjectBriefArgs(rawArgs);
      if (!parsed.ok) return refuse(PROJECT_BRIEF_TOOL, parsed.problems);
      const update: ProjectUpdate = { kind: "brief", brief: parsed.brief, draftedAfterUntrusted: deps.outsideContent(ctx.sessionId) };
      return accepted(
        PROJECT_BRIEF_TOOL,
        `Brief drafted (${parsed.brief.successCriteria.length} success criteria). ${AWAIT_PERSON}`,
        update,
      );
    },
  };
  const plan: ToolDefinition = {
    name: PROJECT_PLAN_TOOL,
    description: "Draft or revise the plan (milestones and tasks) for the approved brief; each task gets a worker, a reviewer and an estimate.",
    readonly: true,
    async run(rawArgs, ctx) {
      const broad = refuseBroadWorkdir(PROJECT_PLAN_TOOL, ctx.workingDir);
      if (broad !== null) return broad;
      const parsed = parseProjectPlanArgs(rawArgs);
      if (!parsed.ok) return refuse(PROJECT_PLAN_TOOL, parsed.problems);
      const context = deps.planContext();
      const enriched = enrichPlanRows(parsed.plan, context);
      if (!enriched.ok) return refuse(PROJECT_PLAN_TOOL, enriched.problems);
      // Reviewed, reference-checked and plan-checked as the store keeps them, so no basis is stale on arrival.
      const kept = storedRows(enriched.rows, parsed.plan.milestones.map((m) => m.id));
      const rows = kept.rows;
      const totals = planTotals(rows);
      const detail = planDetailFor({ rows, totals }, context.projectConfig, false);
      const referenceCheck = deps.planReferences === undefined ? undefined : await deps.planReferences(rows, ctx.workingDir, ctx.signal).catch((err: unknown): PlanReferenceRecord => {
        // A check that could not run is never green (issue #120).
        ctx.signal?.throwIfAborted();
        return { verdict: "warn", detail: `References not checked: ${err instanceof Error ? err.message : String(err)}.`, taskIds: [], basis: planReferenceBasis(rows) };
      });
      let update: Extract<ProjectUpdate, { kind: "plan" }> = {
        kind: "plan",
        milestones: parsed.plan.milestones,
        rows,
        detail,
        draftedAfterUntrusted: deps.outsideContent(ctx.sessionId),
        ...(referenceCheck === undefined ? {} : { referenceCheck }),
      };
      // The milestones as this draft would leave them (issue #112): a finished one counts only for what it ran under.
      const folded = ctx.project === undefined ? null : applyProjectUpdate(ctx.project, update, 0);
      const milestonesAfter = folded !== null && folded.ok ? folded.project.milestones : (ctx.project?.milestones ?? []);
      const criteria = ctx.project?.approvedCriteria ?? (ctx.project?.brief?.status === "approved" ? ctx.project.brief.successCriteria : []);
      const planChecks = evaluatePlanChecks(rows, criteria, { ...(referenceCheck === undefined ? {} : { references: referenceCheck }), ...(ctx.project === undefined ? {} : backlogCheckOptions(folded !== null && folded.ok ? folded.project : ctx.project, { status: "draft" })) }, ctx.project === undefined ? [] : planDecisionsOf(ctx.project), finishedCitationsOf(milestonesAfter));
      // Issue #118: the plan reviewer, before the gate reaches the person.
      const review = await reviewDraft(deps, ctx, { update, rows, criteria, planChecks });
      if (review !== undefined) update = { ...update, planReview: review, ...(review.sentBack ? { holdForReview: true as const } : {}) };
      const lines = [
        `Plan drafted: ${parsed.plan.milestones.length} milestone${parsed.plan.milestones.length === 1 ? "" : "s"}, ${rows.length} task${rows.length === 1 ? "" : "s"}, ${usd(totals.costUsd)}${totals.unknownCostRows > 0 ? ` (+${totals.unknownCostRows} unpriced)` : ""}.`,
        ...parsed.plan.milestones.flatMap((m) => [
          `${m.id} (${m.kind}): ${m.title}`,
          ...rows
            .filter((r) => r.milestoneId === m.id)
            .map((r) => `  ${r.taskId}: ${r.worker}${r.reviewer === null ? "" : `, review ${r.reviewer}`}; ${rowUsd(r)}, ${secs(r.estMs)}`),
        ]),
        ...enriched.notes,
        ...kept.notes,
        "Use these task ids in fusion.delegate when the milestone is approved.",
        ...backlogLines(ctx.project),
        ...planChecks.map(planCheckHint),
        ...(review === undefined ? [] : reviewLines(review, rows, parsed.plan.milestones.map((m) => m.id), { criteria, planChecks, ...(ctx.project === undefined ? {} : { personCalls: planReviewPersonCalls(ctx.project) }) }, deps)),
        review?.sentBack === true ? REVISE_FOR_REVIEW : AWAIT_PERSON,
      ];
      // Issue #77: say which results stop counting, so the reply can tell the person.
      const resets = projectVerdictResets(ctx.project, update);
      if (resets.length > 0) {
        lines.splice(lines.length - 1, 0, ...resets.map(verdictResetHint), "Their earlier results moved to history; tell the person these run again.");
      }
      const result = accepted(PROJECT_PLAN_TOOL, lines.join("\n"), update);
      return { ...result, details: { ...result.details, planChecks } };
    },
  };
  const milestone: ToolDefinition = {
    name: PROJECT_MILESTONE_TOOL,
    description: "Report an approved milestone's result (done or failed, with a summary) for the person to review before the next one.",
    readonly: true,
    async run(rawArgs, ctx) {
      const parsed = parseProjectMilestoneArgs(rawArgs);
      if (!parsed.ok) return refuse(PROJECT_MILESTONE_TOOL, parsed.problems);
      let report: Extract<ProjectUpdate, { kind: "milestone" }> = parsed.report;
      const lines: string[] = [];
      // A done milestone carries its runs' criteria facts (issue #40),
      // and their screenshots when the report names none: the runtime's,
      // never the model's (its arguments cannot carry facts).
      const milestone = ctx.project?.milestones.find((m) => m.id === report.id);
      // The required tasks: the approved plan's rows for this milestone
      // that name a reviewer (issue #98); a "no review" row records no
      // verdict and never blocks.
      const requiredTasks = (ctx.project?.plan?.rows ?? [])
        .filter((r) => r.milestoneId === report.id && r.reviewer !== null)
        .map((r) => r.taskId);
      if (report.state === "failed" && milestone !== undefined && deps.milestoneEvidence !== undefined && requiredTasks.length > 0) {
        // A failed result keeps its open reviews for the person's gate (issue #98).
        const approvals = ctx.project?.briefApprovals;
        const failedEvidence = deps.milestoneEvidence(milestone, (ctx.project?.brief?.successCriteria ?? []).map((c) => c.id), {
          criteria: ctx.project?.brief?.successCriteria ?? [],
          ...(approvals === undefined ? {} : { briefApprovals: approvals }),
          requiredTasks,
        });
        // Bounded correction (issue #100): with concrete blockers, rounds
        // left and budget, the director fixes first instead of giving up.
        const correction = failedEvidence.correction;
        // A reviewer that could not run is reason enough to report failed: never held back.
        const reviewerDown = (failedEvidence.reviewBlocks ?? []).some((b) => REVIEWER_DOWN.test(b.reason));
        if (
          correction !== undefined &&
          !reviewerDown &&
          correction.roundsUsed < MILESTONE_CORRECTION_ROUNDS &&
          (milestone.failedRefusals ?? 0) < MILESTONE_FAILED_REFUSALS &&
          (deps.correctionBudgetLeft?.(ctx.sessionId) ?? true)
        ) {
          // Held, not refused: the fold counts it on the milestone, so the
          // holds end even with no budget cap.
          return accepted(
            PROJECT_MILESTONE_TOOL,
            `Not reported failed: milestone ${report.id}'s reviews name concrete blockers and correction round ${correction.roundsUsed + 1} of ${MILESTONE_CORRECTION_ROUNDS} is left. ${correction.blocked
              .map((b) => `${b.taskId}: ${b.issues.join("; ")}`)
              .join(" | ")}. Delegate a targeted fix for each blocked row under its plan task id with fusion.delegate (the issues in its brief; change only what they name), let both reviews run again, then report the result. Report "failed" only when the rounds or the budget are used up, or a reviewer cannot run.`,
            { ...report, holdForCorrection: true },
          );
        }
        const blocks = failedEvidence.reviewBlocks ?? [];
        if (blocks.length > 0) {
          report = { ...report, reviewBlocks: blocks };
          lines.push(`Review open: ${blocks.map((b) => `${b.taskId} (${b.reason})`).join("; ")}.`);
        }
      }
      if (report.state === "done" && milestone !== undefined && deps.milestoneEvidence !== undefined) {
        const order = (ctx.project?.brief?.successCriteria ?? []).map((c) => c.id);
        const approvals = ctx.project?.briefApprovals;
        const evidence = deps.milestoneEvidence(milestone, order, {
          criteria: ctx.project?.brief?.successCriteria ?? [],
          ...(approvals === undefined ? {} : { briefApprovals: approvals }),
          ...(requiredTasks.length === 0 ? {} : { requiredTasks }),
        });
        // A milestone closes only when its tests AND criteria pass: the
        // person never sees "done" over a red or unverified criterion.
        const open = evidence.facts.filter((f) => f.state !== "passed");
        if (open.length > 0) {
          return refuse(PROJECT_MILESTONE_TOOL, [
            `milestone ${report.id} cannot be reported done: ${open.map((f) => `${f.id} ${f.state}${f.why === undefined ? "" : ` (${f.why})`}`).join(", ")}. Fix it and re-delegate, or report "failed" with the reasons`,
          ]);
        }
        if (evidence.facts.length > 0) {
          report = { ...report, criteriaFacts: evidence.facts };
          lines.push(criterionBasisSummaryLine(summarizeCriterionBases(evidence.facts)));
          lines.push(`Criteria: ${evidence.facts.map((f) => `${f.id} ${f.state}${f.state === "passed" && f.reservation !== undefined ? " with reservations" : ""} (${criterionBasisLabel(f.basis)})`).join(", ")}.`);
        }
        if ((evidence.reviewBlocks ?? []).length > 0) {
          // Issue #98: refused like a red criterion, so the milestone stays
          // in progress and the director can still act on it.
          const blocks = evidence.reviewBlocks!;
          return refuse(PROJECT_MILESTONE_TOOL, [
            `milestone ${report.id} cannot be reported done while a required task has no current accept from its reviewer: ${blocks
              .map((b) => `${b.taskId} (${b.reason}): re-delegate it with its plan task id ${b.taskId}`)
              .join("; ")}. A re-review of unchanged files is allowed when only the evidence changed (the worker may change nothing); a fix under another task id does not count. If the reviewer cannot run, report "failed" with the reason`,
          ]);
        }
        if ((evidence.noReviewVerdict ?? []).length > 0) {
          // A task that ended with no review verdict (issue #95): the person sees it at the gate.
          const warning = `Warning: no review verdict: ${(evidence.noReviewVerdict ?? []).map((n) => `${n.taskId} (${n.reason})`).join("; ")}.`;
          report = { ...report, summary: `${report.summary}\n${warning}` };
          lines.push(warning);
        }
        if (evidence.uncovered.length > 0) {
          // On the report itself, so the person sees it at the gate.
          const warning = `Warning: not covered by a check: ${evidence.uncovered.join(", ")}.`;
          report = { ...report, summary: `${report.summary}\n${warning}` };
          lines.push(warning);
        }
        if (report.attachments === undefined && evidence.attachments.length > 0) {
          report = { ...report, attachments: evidence.attachments };
          lines.push(`${evidence.attachments.length} screenshot${evidence.attachments.length === 1 ? "" : "s"} of its runs attached.`);
        }
      }
      const criteria = ctx.project?.approvedCriteria ?? ctx.project?.brief?.successCriteria ?? [];
      lines.push(...directorReportWarnings(parsed.report.summary, report.criteriaFacts ?? [], criteria).map(directorReportWarningLine));
      // Issue #112: the decisions this milestone's tasks cite; nothing checks them automatically.
      const cited = new Set((ctx.project?.plan?.rows ?? []).filter((r) => r.milestoneId === report.id).flatMap((r) => r.decisions ?? []));
      const decisions = ctx.project === undefined ? [] : activeDecisionsOf(ctx.project).filter((d) => cited.has(d.id));
      if (decisions.length > 0) {
        const line = `Decisions cited by this milestone's tasks, not verified automatically (the reviewers were given them): ${decisions.map((d) => `${d.id} (${d.text})`).join(", ")}.`;
        report = { ...report, summary: `${report.summary}\n${line}` };
        lines.push(line);
      }
      return accepted(
        PROJECT_MILESTONE_TOOL,
        [
          `Milestone ${report.id} reported ${report.state}.`,
          ...lines,
          "Now reply to the person with the result: they approve it (the next milestone starts), correct it or cancel. Do not start the next milestone yourself.",
        ].join(" "),
        report,
      );
    },
  };
  return [brief, plan, milestone];
}
