import { createHash } from "node:crypto";

import { PROJECT_LIMITS } from "./project-limits.js";
import { normalizeCriterionId } from "./project-criterion-id.js";
import type {
  ProjectBacklogCall,
  ProjectBacklogItem,
  ProjectBacklogSource,
  ProjectMilestone,
  ProjectDecisionResult,
  ProjectState,
  ProjectUpdateResult,
} from "./session-project.js";

/** Who proposed a backlog item; re-exported by `session-project.ts`. */
export const PROJECT_BACKLOG_SOURCES: readonly ProjectBacklogSource[] = ["person", "director", "worker", "reviewer"];
/** The sources a director update may name: `person` is not provable from a model's call (review of #111). */
export const DIRECTOR_BACKLOG_SOURCES: readonly ProjectBacklogSource[] = ["director", "worker", "reviewer"];

/** How an item's source reads on every surface: a relayed request is the director's, from the person's message. */
export function backlogSourceLabel(item: Pick<ProjectBacklogItem, "source" | "fromPerson">): string {
  return item.fromPerson === true ? "director (from your message)" : item.source;
}

/**
 * The project backlog (issue #111): work not ready for the plan, kept in
 * the project's store. An item is author content in `project.json`
 * (`ProjectState.backlog`, outside every gate's hash, so adding one
 * reopens no gate); what the person decided on it — promoted or dropped
 * — is theirs alone and lives in the state dir's record
 * (`backlogStates`, `backlogCalls`), never in the file. A call is bound
 * to the item's text as the person saw it ({@link backlogItemHash}): an
 * item edited outside Atomic Agent since reads open again, and the plan
 * gate says so ({@link staleBacklogCalls}); a decided id is never given
 * to a new item.
 *
 * The director adds items (`project.backlog.add`, orchestrator only);
 * workers and reviewers only suggest them in their replies. Only the
 * person promotes, drops or reopens one ({@link applyBacklogDecision},
 * never an automatic approval). A promoted item is a proposal for the
 * next plan: the director drafts it in on a task that cites it
 * (`rows[].backlog`, issue #146), the plan cannot be approved until each
 * is cited or the person defers it at the plan gate, and the approved
 * plan takes in the items it cites on milestones not started yet
 * ({@link markPromotedPlanned}, {@link backlogTakenIn}). An item with a
 * `condition` is a seed: shown to the person at each plan and milestone
 * gate while open; nothing activates by itself.
 */

/** What `project.backlog.add` folds in; `createdAt` is the fold's. */
export interface ProjectBacklogDraft {
  /** Absent: the fold allocates the next id ({@link nextBacklogId}), so two adds of one step never share one. */
  id?: string;
  title: string;
  note?: string;
  condition?: string;
  source: ProjectBacklogSource;
  /** With `source: "director"`: recorded from the person's message. */
  fromPerson?: true;
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

type BacklogView = Pick<ProjectState, "backlog" | "backlogStates" | "backlogCalls"> & Partial<Pick<ProjectState, "plan" | "milestones">>;

/**
 * Issue #146: a milestone whose work was dispatched (running, a result,
 * or a run recorded): a backlog citation added to its tasks since adds no
 * work, so only what it was approved with (`backlogCited`) counts for it.
 */
export function milestoneStarted(m: Pick<ProjectMilestone, "state" | "runIds">): boolean {
  return m.state === "in_progress" || m.state === "done" || m.state === "reviewed" || m.state === "failed" || m.runIds.length > 0;
}

/**
 * Issue #146: the plan version that took a promoted item in, while that
 * still stands: the current plan cites it on a task of a milestone not
 * started ({@link milestoneStarted}), or a started milestone cited it in
 * the plan it was approved under (`backlogCited`). A re-plan that drops the citation before
 * the work ran puts the item back among those the next plan must take
 * in. A call taken in by #111's rule (no `cited`) stands as recorded.
 */
export function backlogTakenIn(project: BacklogView, id: string): number | undefined {
  const call = project.backlogCalls?.[id];
  if (call?.plannedIn === undefined) return undefined;
  if (call.cited !== true) return call.plannedIn;
  const milestones = project.milestones ?? [];
  const started = new Set(milestones.filter(milestoneStarted).map((m) => m.id));
  const ran = milestones.some((m) => started.has(m.id) && (m.backlogCited ?? []).includes(id));
  const planned = (project.plan?.rows ?? []).some((r) => !started.has(r.milestoneId) && (r.backlog ?? []).includes(id));
  return ran || planned ? call.plannedIn : undefined;
}

/** What a person's call on an item is bound to: its title, note and condition (not its source, origin or time). */
export function backlogItemHash(item: Pick<ProjectBacklogItem, "title" | "note" | "condition">): string {
  return createHash("sha256").update(JSON.stringify([item.title, item.note ?? null, item.condition ?? null])).digest("hex").slice(0, 16);
}

/**
 * An item's state: the record's call while the item still reads as the
 * person decided it (same {@link backlogItemHash}), else open — the same
 * rule as a decision's status (#80): a call belongs to the text it was made on.
 */
export function backlogStateOf(project: BacklogView, id: string): ProjectBacklogItemState {
  const state = project.backlogStates?.[id];
  if (state === undefined) return "open";
  const item = (project.backlog ?? []).find((b) => b.id === id);
  return item !== undefined && project.backlogCalls?.[id]?.hash === backlogItemHash(item) ? state : "open";
}

/** The items nobody decided on yet, in backlog order. */
export function openBacklog(project: BacklogView): ProjectBacklogItem[] {
  return (project.backlog ?? []).filter((b) => backlogStateOf(project, b.id) === "open");
}

/** The open items with a condition: the seeds the person is shown at a plan or milestone gate. */
export function openSeeds(project: BacklogView): ProjectBacklogItem[] {
  return openBacklog(project).filter((b) => b.condition !== undefined);
}

/** The items the person promoted that no plan they approved has taken in yet. */
export function promotedForPlan(project: BacklogView): ProjectBacklogItem[] {
  return (project.backlog ?? []).filter((b) => backlogStateOf(project, b.id) === "promoted" && backlogTakenIn(project, b.id) === undefined);
}

/**
 * The person's calls that no longer stand (review of #111): the item was
 * changed outside Atomic Agent since (`changed`: it reads open again), or
 * a promoted one was removed from `project.json` (`removed`). A dropped
 * item removed is what dropping meant, so it is not listed.
 */
export function staleBacklogCalls(project: BacklogView): Array<{ id: string; state: "promoted" | "dropped"; reason: "changed" | "removed" }> {
  const out: Array<{ id: string; state: "promoted" | "dropped"; reason: "changed" | "removed" }> = [];
  for (const [id, state] of Object.entries(project.backlogStates ?? {})) {
    const item = (project.backlog ?? []).find((b) => b.id === id);
    if (item === undefined) {
      if (state === "promoted") out.push({ id, state, reason: "removed" });
    } else if (project.backlogCalls?.[id]?.hash !== backlogItemHash(item)) out.push({ id, state, reason: "changed" });
  }
  return out;
}

/** Ids no new item may take: the backlog's, and every id the person decided on (kept in the record). */
function reservedIds(project: BacklogView | undefined): Set<string> {
  return new Set([...(project?.backlog ?? []).map((b) => b.id), ...Object.keys(project?.backlogStates ?? {}), ...Object.keys(project?.backlogCalls ?? {})]);
}

/** The next `b<n>` id: past every `b<n>` the backlog or the record has held, so a decided id is never reused. */
export function nextBacklogId(project: BacklogView | undefined): string {
  let max = 0;
  for (const id of reservedIds(project)) {
    const m = /^b(\d+)$/.exec(id);
    if (m !== null) max = Math.max(max, Number(m[1]));
  }
  return `b${max + 1}`;
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
  // Dropped items are kept (the person's call stands) but free their place.
  if (backlog.filter((b) => backlogStateOf(project, b.id) !== "dropped").length >= PROJECT_LIMITS.backlog) {
    return invalid(`the backlog holds ${PROJECT_LIMITS.backlog} open or promoted items, its limit; ask the person to drop some`);
  }
  if (backlog.length >= PROJECT_LIMITS.backlogStored) {
    return invalid(`project.json keeps ${PROJECT_LIMITS.backlogStored} backlog items, dropped ones included; ask the person to remove dropped items from it`);
  }
  const id = raw.id === undefined ? nextBacklogId(project) : normalizeCriterionId(raw.id);
  if (id === null) return invalid(`a backlog id must be 1..${PROJECT_LIMITS.criterionId} characters of a-z, 0-9 and -`);
  if (reservedIds(project).has(id)) return invalid(`backlog id ${id} is used already (by an item or by the person's call on one); take ${nextBacklogId(project)}`);
  const title = typeof raw.title === "string" ? clip(raw.title, PROJECT_LIMITS.title) : "";
  if (title.length === 0) return invalid("a backlog item needs a title");
  if (typeof raw.source !== "string" || !(DIRECTOR_BACKLOG_SOURCES as readonly string[]).includes(raw.source)) {
    return invalid(`source must be one of ${DIRECTOR_BACKLOG_SOURCES.join(", ")} (an item the person asked for: director with fromPerson)`);
  }
  if (raw.fromPerson !== undefined && (raw.fromPerson !== true || raw.source !== "director")) return invalid("fromPerson goes with source director");
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
    ...(raw.fromPerson === true ? { fromPerson: true as const } : {}),
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
  if (project.cancelledAt !== undefined) return { ok: false, error: { code: "no-project", message: "The project was cancelled; its backlog takes no more calls." } };
  if (!["promoted", "dropped", "open"].includes(decision.state)) {
    return { ok: false, error: { code: "invalid", message: "a backlog item is promoted, dropped or open" } };
  }
  const item = (project.backlog ?? []).find((b) => b.id === decision.id);
  // A call on an item removed outside Atomic Agent can only be taken back (it clears the flag).
  const orphan = item === undefined && project.backlogStates?.[decision.id] !== undefined;
  if (item === undefined && !(orphan && decision.state === "open")) {
    return { ok: false, error: { code: "invalid", message: `the backlog has no item ${decision.id}` } };
  }
  const states = { ...(project.backlogStates ?? {}) };
  const calls = { ...(project.backlogCalls ?? {}) };
  if (decision.state === "open") {
    delete states[decision.id];
    delete calls[decision.id];
  } else {
    states[decision.id] = decision.state;
    // Bound to the text the person decided on; a promotion given again waits for a plan again.
    calls[decision.id] = { hash: backlogItemHash(item!) };
  }
  const { backlogStates: _s, backlogCalls: _c, ...rest } = project;
  return {
    ok: true,
    project: {
      ...rest,
      ...(Object.keys(states).length === 0 ? {} : { backlogStates: states }),
      ...(Object.keys(calls).length === 0 ? {} : { backlogCalls: calls }),
    },
  };
}

/**
 * The person approved plan `version` (issue #146): each promoted item
 * waiting for a plan that a task of a milestone still to run cites
 * (`rows[].backlog`) is recorded as taken in by it, its deferral, if
 * any, dropped. One the plan does not cite (the person deferred it)
 * keeps waiting; a citation on a done or reviewed milestone's task
 * takes nothing in.
 */
export function markPromotedPlanned(project: ProjectState, version: number): ProjectState {
  // A started milestone keeps what it was approved with; only those not started take this plan's citations.
  const finished = new Set(project.milestones.filter(milestoneStarted).map((m) => m.id));
  const rows = project.plan?.rows ?? [];
  // Each milestone that will run records what its tasks cite in the plan approved (its snapshot).
  const milestones = project.milestones.map((m) => {
    if (finished.has(m.id)) return m;
    const cited = [...new Set(rows.filter((r) => r.milestoneId === m.id).flatMap((r) => r.backlog ?? []))];
    const { backlogCited: _old, ...rest } = m;
    return cited.length === 0 ? (m.backlogCited === undefined ? m : rest) : { ...rest, backlogCited: cited };
  });
  const cited = new Set(rows.filter((r) => !finished.has(r.milestoneId)).flatMap((r) => r.backlog ?? []));
  const taken = promotedForPlan(project).filter((b) => cited.has(b.id));
  if (taken.length === 0) return { ...project, milestones };
  const calls: Record<string, ProjectBacklogCall> = { ...(project.backlogCalls ?? {}) };
  for (const b of taken) {
    const { deferred: _d, ...call } = calls[b.id]!;
    calls[b.id] = { ...call, plannedIn: version, cited: true };
  }
  return { ...project, milestones, backlogCalls: calls };
}

/**
 * A surface's request for {@link applyBacklogDecision} (`item`, `state`),
 * shape only: the HTTP route and the sidecar command. A message when malformed.
 */
export function parseBacklogDecision(raw: Record<string, unknown>): ProjectBacklogDecision | string {
  const id = typeof raw.item === "string" ? raw.item.trim() : "";
  if (id.length === 0 || id.length > PROJECT_LIMITS.id) return "item must be a backlog item's id";
  if (raw.state !== "promoted" && raw.state !== "dropped" && raw.state !== "open") return "state must be promoted, dropped or open";
  return { id, state: raw.state };
}
