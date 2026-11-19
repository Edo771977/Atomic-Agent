import { compressToolResult, type CompressedToolResult } from "../../compressor/result-compressor.js";
import type { UserFusionProjectConfig } from "../../config/llm-run-mode-config.js";
import type { TeamMember } from "../../llm/run-mode/fusion-team.js";
import {
  CRITERION_ID_PATTERN,
  MILESTONE_KINDS,
  PROJECT_LIMITS,
  planTotals,
  projectVerdictResets,
  type AssignmentRow,
  type MilestoneKind,
  type ProjectBriefDraft,
  type ProjectCriterion,
  type ProjectCriterionInput,
  type ProjectMilestone,
  type ProjectMilestoneAttachment,
  type ProjectGameBrief,
  type ProjectUpdate,
} from "../../session/session-project.js";
import type { ToolDefinition } from "../tool-registry.js";
import type { OutcomeRecord } from "./outcome-log.js";
import { estimateRow, planDetailFor, withReviewEstimate } from "./project-estimate.js";
import { verdictResetHint } from "./project-gate-view.js";
import { isTooBroadScope, tooBroadWorkdirMessage } from "./scope-path.js";
import type { WorkerPricing } from "./worker-result.js";
import type { MilestoneEvidence } from "./run-criteria.js";

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
/** In catalog order. */
export const PROJECT_TOOL_NAMES = [PROJECT_BRIEF_TOOL, PROJECT_PLAN_TOOL, PROJECT_MILESTONE_TOOL] as const;

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
  milestoneEvidence?: (
    milestone: ProjectMilestone,
    criteriaOrder: readonly string[],
    /** The approved brief's criteria and approval time: run facts count only for the text they tested (issue #87). */
    current: { criteria: readonly ProjectCriterion[]; briefApprovals?: number },
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
  const problems: string[] = unknownKeys(raw, ["what", "users", "how", "game", "successCriteria"], "project.brief");
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
      successCriteria: criteria as ProjectCriterionInput[],
    },
  };
}

// ------------------------------------------------------------------- plan

export interface ProjectPlanTaskArgs {
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
      problems.push(...unknownKeys(t, ["id", "title", "milestone", "worker", "reviewer"], `task ${id}`));
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
  const byModel = members.filter((m) => m.model === name);
  return byModel.length === 1 ? byModel[0] : undefined;
}

/** The plan's rows with workers, reviewers and estimates, or the problems. */
export function enrichPlanRows(plan: ProjectPlanArgs, context: ProjectPlanContext): { ok: true; rows: AssignmentRow[] } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const rows: AssignmentRow[] = [];
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
    if (!context.reviewOn) reviewer = null;
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
  return problems.length > 0 ? { ok: false, problems } : { ok: true, rows };
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
      const rows = enriched.rows;
      const totals = planTotals(rows);
      const detail = planDetailFor({ rows, totals }, context.projectConfig, false);
      const lines = [
        `Plan drafted: ${parsed.plan.milestones.length} milestone${parsed.plan.milestones.length === 1 ? "" : "s"}, ${rows.length} task${rows.length === 1 ? "" : "s"}, ${usd(totals.costUsd)}${totals.unknownCostRows > 0 ? ` (+${totals.unknownCostRows} unpriced)` : ""}.`,
        ...parsed.plan.milestones.flatMap((m) => [
          `${m.id} (${m.kind}): ${m.title}`,
          ...rows
            .filter((r) => r.milestoneId === m.id)
            .map((r) => `  ${r.taskId}: ${r.worker}${r.reviewer === null ? "" : `, review ${r.reviewer}`}; ${rowUsd(r)}, ${secs(r.estMs)}`),
        ]),
        "Use these task ids in fusion.delegate when the milestone is approved.",
        AWAIT_PERSON,
      ];
      const update: ProjectUpdate = {
        kind: "plan",
        milestones: parsed.plan.milestones,
        rows,
        detail,
        draftedAfterUntrusted: deps.outsideContent(ctx.sessionId),
      };
      // Issue #77: say which results stop counting, so the reply can tell the person.
      const resets = projectVerdictResets(ctx.project, update);
      if (resets.length > 0) {
        lines.splice(lines.length - 1, 0, ...resets.map(verdictResetHint), "Their earlier results moved to history; tell the person these run again.");
      }
      return accepted(PROJECT_PLAN_TOOL, lines.join("\n"), update);
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
      if (report.state === "done" && milestone !== undefined && deps.milestoneEvidence !== undefined) {
        const order = (ctx.project?.brief?.successCriteria ?? []).map((c) => c.id);
        const approvals = ctx.project?.briefApprovals;
        const evidence = deps.milestoneEvidence(milestone, order, {
          criteria: ctx.project?.brief?.successCriteria ?? [],
          ...(approvals === undefined ? {} : { briefApprovals: approvals }),
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
          lines.push(`Criteria: ${evidence.facts.map((f) => `${f.id} ${f.state}`).join(", ")}.`);
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
