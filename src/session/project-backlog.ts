import { PROJECT_LIMITS } from "./project-limits.js";
import { normalizeCriterionId } from "./project-criterion-id.js";
import type {
  ProjectBacklogItem,
  ProjectBacklogSource,
  ProjectDecisionResult,
  ProjectState,
  ProjectUpdateResult,
} from "./session-project.js";

/** Who proposed a backlog item; re-exported by `session-project.ts`. */
export const PROJECT_BACKLOG_SOURCES: readonly ProjectBacklogSource[] = ["person", "director", "worker", "reviewer"];

/**
 * The project backlog (issue #111): work not ready for the plan, kept in
 * the project's store. An item is author content in `project.json`
 * (`ProjectState.backlog`, outside every gate's hash, so adding one
 * reopens no gate); what the person decided on it — promoted or dropped
 * — is theirs alone and lives in the state dir's record
 * (`backlogStates`, `backlogPlanned`), never in the file.
 *
 * The director adds items (`project.backlog.add`, orchestrator only);
 * workers and reviewers only suggest them in their replies. Only the
 * person promotes, drops or reopens one ({@link applyBacklogDecision},
 * never an automatic approval). A promoted item is a proposal for the
 * next plan: the director drafts it in, and the plan the person approves
 * next takes it in ({@link markPromotedPlanned}). An item with a
 * `condition` is a seed: shown to the person at each plan and milestone
 * gate while open; nothing activates by itself.
 */

/** What `project.backlog.add` folds in; `createdAt` is the fold's. */
export interface ProjectBacklogDraft {
  id: string;
  title: string;
  note?: string;
  condition?: string;
  source: ProjectBacklogSource;
  origin?: { milestoneId?: string; taskId?: string };
}

/** The person's call; `open` takes back an earlier one. */
export interface ProjectBacklogDecision {
  id: string;
  state: "promoted" | "dropped" | "open";
}

export type ProjectBacklogItemState = "open" | "promoted" | "dropped";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function clip(raw: string, max: number): string {
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

const cleanRef = (v: unknown): string | null =>
  typeof v === "string" && v.trim().length > 0 && v.trim().length <= PROJECT_LIMITS.id && !/\s/.test(v.trim()) ? v.trim() : null;

const invalid = (message: string): ProjectUpdateResult => ({ ok: false, error: { code: "invalid", message } });

/** An item's state: the record's call, else open. */
export function backlogStateOf(project: Pick<ProjectState, "backlogStates">, id: string): ProjectBacklogItemState {
  return project.backlogStates?.[id] ?? "open";
}

/** The items nobody decided on yet, in backlog order. */
export function openBacklog(project: Pick<ProjectState, "backlog" | "backlogStates">): ProjectBacklogItem[] {
  return (project.backlog ?? []).filter((b) => backlogStateOf(project, b.id) === "open");
}

/** The open items with a condition: the seeds the person is shown at a plan or milestone gate. */
export function openSeeds(project: Pick<ProjectState, "backlog" | "backlogStates">): ProjectBacklogItem[] {
  return openBacklog(project).filter((b) => b.condition !== undefined);
}

/** The items the person promoted that no plan they approved has taken in yet. */
export function promotedForPlan(project: Pick<ProjectState, "backlog" | "backlogStates" | "backlogPlanned">): ProjectBacklogItem[] {
  const planned = new Set(project.backlogPlanned ?? []);
  return (project.backlog ?? []).filter((b) => backlogStateOf(project, b.id) === "promoted" && !planned.has(b.id));
}

/** The first free `b<n>` id, counting from the backlog's length. */
export function nextBacklogId(project: Pick<ProjectState, "backlog"> | undefined): string {
  const taken = new Set((project?.backlog ?? []).map((b) => b.id));
  let n = taken.size + 1;
  while (taken.has(`b${n}`)) n += 1;
  return `b${n}`;
}

/**
 * Fold a new item (`project.backlog.add`). Refused without a brief, after
 * a cancel, over {@link PROJECT_LIMITS}.backlog items, for a bad or
 * repeated id, an empty title, an unknown source, or an origin the plan
 * does not hold. A worker's or reviewer's item names the plan task whose
 * run it came from (its milestone ran). Text is clipped. The gate, the
 * plan and every milestone stay as they are; no state is taken from the
 * draft (an item starts open).
 */
export function applyBacklogAdd(project: ProjectState | undefined, raw: unknown, now: number): ProjectUpdateResult {
  if (project === undefined || project.brief === undefined) return invalid("there is no project yet: draft the brief first");
  if (project.cancelledAt !== undefined) {
    return { ok: false, error: { code: "cancelled", message: "The person cancelled this project; draft a new brief to start over." } };
  }
  if (!isObject(raw)) return invalid("the backlog item is malformed");
  const backlog = project.backlog ?? [];
  if (backlog.length >= PROJECT_LIMITS.backlog) {
    return invalid(`the backlog holds ${PROJECT_LIMITS.backlog} items, its limit; ask the person to drop some`);
  }
  const id = normalizeCriterionId(raw.id);
  if (id === null) return invalid(`a backlog id must be 1..${PROJECT_LIMITS.criterionId} characters of a-z, 0-9 and -`);
  if (backlog.some((b) => b.id === id)) return invalid(`backlog item ${id} exists already`);
  const title = typeof raw.title === "string" ? clip(raw.title, PROJECT_LIMITS.title) : "";
  if (title.length === 0) return invalid("a backlog item needs a title");
  if (typeof raw.source !== "string" || !(PROJECT_BACKLOG_SOURCES as readonly string[]).includes(raw.source)) {
    return invalid(`source must be one of ${PROJECT_BACKLOG_SOURCES.join(", ")}`);
  }
  const source = raw.source as ProjectBacklogSource;
  const origin = isObject(raw.origin) ? raw.origin : undefined;
  if (raw.origin !== undefined && origin === undefined) return invalid("origin must be { milestoneId?, taskId? }");
  const milestoneId = origin?.milestoneId === undefined ? null : cleanRef(origin.milestoneId);
  const taskId = origin?.taskId === undefined ? null : cleanRef(origin.taskId);
  if (origin?.milestoneId !== undefined && (milestoneId === null || !project.milestones.some((m) => m.id === milestoneId))) {
    return invalid(`origin: the plan has no milestone ${JSON.stringify(origin.milestoneId)}`);
  }
  const row = taskId === null ? undefined : (project.plan?.rows ?? []).find((r) => r.taskId === taskId);
  if (origin?.taskId !== undefined && row === undefined) return invalid(`origin: the plan has no task ${JSON.stringify(origin.taskId)}`);
  if (row !== undefined && milestoneId !== null && row.milestoneId !== milestoneId) {
    return invalid(`origin: task ${row.taskId} is in milestone ${row.milestoneId}, not ${milestoneId}`);
  }
  if (source === "worker" || source === "reviewer") {
    // Checked against the run: the task's milestone must have run.
    const ran = row === undefined ? undefined : project.milestones.find((m) => m.id === row.milestoneId);
    if (ran === undefined || (ran.runIds.length === 0 && (ran.history ?? []).every((h) => h.runIds.length === 0))) {
      return invalid(`a ${source}'s item names origin.taskId, the plan task whose run it came from`);
    }
  }
  const note = typeof raw.note === "string" ? clip(raw.note, PROJECT_LIMITS.shortText) : "";
  const condition = typeof raw.condition === "string" ? clip(raw.condition, PROJECT_LIMITS.shortText) : "";
  const item: ProjectBacklogItem = {
    id,
    title,
    ...(note.length === 0 ? {} : { note }),
    ...(condition.length === 0 ? {} : { condition }),
    source,
    createdAt: now,
    ...(milestoneId === null && taskId === null ? {} : { origin: { ...(milestoneId === null ? {} : { milestoneId }), ...(taskId === null ? {} : { taskId }) } }),
  };
  return { ok: true, project: { ...project, backlog: [...backlog, item] } };
}

/**
 * The person's call on a backlog item: promote it (a proposal for the
 * next plan), drop it, or take a call back (`open`). Pure; no gate moves.
 * Only a person's surface calls this (`runtime.projectBacklogDecision`,
 * `atomic-agent project backlog --promote/--drop`); no director update
 * and no automatic approval carries it.
 */
export function applyBacklogDecision(project: ProjectState | undefined, decision: ProjectBacklogDecision): ProjectDecisionResult {
  if (project === undefined) return { ok: false, error: { code: "no-project", message: "There is no project to decide on." } };
  if (!["promoted", "dropped", "open"].includes(decision.state)) {
    return { ok: false, error: { code: "invalid", message: "a backlog item is promoted, dropped or open" } };
  }
  if (!(project.backlog ?? []).some((b) => b.id === decision.id)) {
    return { ok: false, error: { code: "invalid", message: `the backlog has no item ${decision.id}` } };
  }
  const states = { ...(project.backlogStates ?? {}) };
  if (decision.state === "open") delete states[decision.id];
  else states[decision.id] = decision.state;
  const planned = (project.backlogPlanned ?? []).filter((id) => id !== decision.id);
  const { backlogStates: _s, backlogPlanned: _p, ...rest } = project;
  return {
    ok: true,
    project: {
      ...rest,
      ...(Object.keys(states).length === 0 ? {} : { backlogStates: states }),
      // A promotion taken back and given again waits for a plan again.
      ...(planned.length === 0 ? {} : { backlogPlanned: planned }),
    },
  };
}

/** The person approved a plan: every promoted item waiting for one is taken in. */
export function markPromotedPlanned(project: ProjectState): ProjectState {
  const waiting = promotedForPlan(project);
  if (waiting.length === 0) return project;
  return { ...project, backlogPlanned: [...(project.backlogPlanned ?? []), ...waiting.map((b) => b.id)] };
}
