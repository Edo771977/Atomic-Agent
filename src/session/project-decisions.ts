import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
  applyProjectUpdate,
  normalizeProject,
  type AssignmentRow,
  type PlanDetail,
  type ProjectGate,
  type ProjectMilestone,
  type ProjectState,
  type ProjectVerdict,
} from "./session-project.js";

/**
 * A fusion project's record in the user's state dir (issue #109): the
 * project as Atomic Agent last wrote it — everything the runtime owns
 * (milestone states, runs, outcomes, review blocks, criteria facts,
 * pictures, corrections, plan flags, versions) and the person's
 * decisions — with the list of those decisions. It is the source for
 * dispatch, gates, evidence and review.
 *
 * `project.json` in the project folder holds the author content (brief,
 * criteria, plan rows, milestones' ids, titles and kinds) and a readable
 * mirror of the rest, never read back. Only an author edit of the file
 * is taken, and only as an untrusted draft through the same rules as the
 * director's (`applyProjectUpdate`): it reopens the gate it changed, and
 * stays listed in `changedOutside` (stored here) until the person decides
 * that gate. An edit the rules refuse at that moment (a milestone result
 * waits for the person) is not taken. With no record (another machine, a
 * moved or copied folder) the project opens with its author content only:
 * execution state and gates start over.
 */

/** What a person decided, as the record keeps it. */
export interface ProjectDecisionInput {
  gate: ProjectGate;
  /** `gateVersion` the decision was taken against. */
  version: number;
  verdict: ProjectVerdict;
}

export interface ProjectDecisionRecord extends ProjectDecisionInput {
  seq: number;
  at: number;
  /** Hash of the content the gate covered when it was decided. */
  hash: string;
}

/** One project's record file. */
export interface ProjectRecord {
  version: 1;
  /** The project folder's identity ({@link canonicalProjectFolder}): a record is a folder's, not an id's. */
  folder: string;
  id: string;
  /** +1 on every write; a write names the one it builds on. */
  seq: number;
  /** The project as Atomic Agent last wrote it, `changedOutside` included. */
  state: ProjectState;
  decisions: ProjectDecisionRecord[];
}

const MAX_DECISIONS = 200;

// ------------------------------------------------------------- content

/** JSON with sorted keys: the same value always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const sha = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

/** A milestone's outcome as the mirror shows it: the person's `approved` reads as `planned`, `reviewed` as `done`. */
function mirrorState(state: ProjectMilestone["state"]): ProjectMilestone["state"] {
  if (state === "approved") return "planned";
  if (state === "reviewed") return "done";
  return state;
}

/**
 * The project as `project.json` holds it: the content and a readable
 * mirror of the runtime's part, with every person decision taken out
 * (brief and plan read as drafts, approvals and corrections gone, gate
 * `none`). Only {@link authorContent} of it is ever read back.
 */
export function projectContent(project: ProjectState): ProjectState {
  const brief = project.brief === undefined ? undefined : (() => {
    const { approvedAt: _a, ...rest } = project.brief;
    return { ...rest, status: "draft" as const };
  })();
  const plan = project.plan === undefined ? undefined : (() => {
    const { approvedAt: _a, approvedWithUntrustedWarning: _w, ...rest } = project.plan;
    return { ...rest, status: "draft" as const };
  })();
  return {
    ...(brief === undefined ? {} : { brief }),
    ...(plan === undefined ? {} : { plan }),
    milestones: project.milestones.map((m) => {
      const { reviewOverride: _o, corrections: _c, ...rest } = m;
      return { ...rest, state: mirrorState(m.state) };
    }),
    gate: { kind: "none" },
  };
}

/** What the person approves and may edit by hand: the brief's text, the plan's rows, the milestones' names. */
export interface ProjectAuthorContent {
  brief?: { what: string; users: string; how: string; game?: unknown; successCriteria: Array<{ id: string; text: string }> };
  plan?: { rows: AssignmentRow[]; detail: PlanDetail };
  milestones: Array<{ id: string; title: string; kind: ProjectMilestone["kind"] }>;
}

export function authorContent(project: ProjectState): ProjectAuthorContent {
  return {
    ...(project.brief === undefined
      ? {}
      : {
          brief: {
            what: project.brief.what,
            users: project.brief.users,
            how: project.brief.how,
            ...(project.brief.game === undefined ? {} : { game: project.brief.game }),
            successCriteria: project.brief.successCriteria.map((c) => ({ id: c.id, text: c.text })),
          },
        }),
    ...(project.plan === undefined ? {} : { plan: { rows: project.plan.rows, detail: project.plan.detail } }),
    milestones: project.milestones.map((m) => ({ id: m.id, title: m.title, kind: m.kind })),
  };
}

const briefPart = (a: ProjectAuthorContent) => canonicalJson(a.brief ?? null);
const planPart = (a: ProjectAuthorContent) => canonicalJson({ plan: a.plan ?? null, milestones: a.milestones });

/** The hash a decision at `gate` covers in `project`; null when the gate names nothing there. */
export function gateContentHash(project: ProjectState, gate: ProjectGate): string | null {
  const author = authorContent(project);
  if (gate.kind === "brief") return author.brief === undefined ? null : sha(author.brief);
  if (gate.kind === "plan") return author.plan === undefined ? null : sha({ plan: author.plan, milestones: author.milestones });
  if (gate.kind === "milestone") {
    const m = project.milestones.find((x) => x.id === gate.id);
    if (m === undefined) return null;
    const { updatedAt: _u, ...rest } = m;
    return sha({ milestone: rest, rows: (project.plan?.rows ?? []).filter((r) => r.milestoneId === m.id) });
  }
  return sha(author);
}

/** The label a gate has in `changedOutside`. */
export function gateLabelOf(gate: ProjectGate): string {
  return gate.kind === "milestone" ? `milestone:${gate.id}` : gate.kind;
}

/**
 * `project` with `labels` as its `changedOutside`. A draft whose gate is
 * listed reads as drafted after untrusted content, whoever wrote it last:
 * the content came from outside and no person has decided it yet, so the
 * card warns and an approval stands in for nothing more.
 */
function withChanged(project: ProjectState, labels: readonly string[]): ProjectState {
  const unique = [...new Set(labels)];
  const { changedOutside: _c, ...rest } = project;
  if (unique.length === 0) return rest;
  const brief = rest.brief !== undefined && unique.includes("brief") && rest.brief.status === "draft" ? { ...rest.brief, draftedAfterUntrusted: true } : rest.brief;
  const plan = rest.plan !== undefined && unique.includes("plan") && rest.plan.status === "draft" ? { ...rest.plan, draftedAfterUntrusted: true } : rest.plan;
  return { ...rest, ...(brief === undefined ? {} : { brief }), ...(plan === undefined ? {} : { plan }), changedOutside: unique };
}

/**
 * With no record: the author content alone, as a draft. The brief waits
 * for the person; the plan's rows stay a draft for the director to
 * submit; every milestone starts over with no runs or evidence.
 */
export function freshFromContent(file: ProjectState): ProjectState {
  const a = authorContent(file);
  const at = file.milestones.reduce((t, m) => Math.max(t, m.updatedAt), 0);
  const fresh = normalizeProject({
    ...(a.brief === undefined ? {} : { brief: { version: 1, ...a.brief, status: "draft", draftedAfterUntrusted: true } }),
    ...(a.plan === undefined ? {} : { plan: { rows: a.plan.rows, detail: a.plan.detail, status: "draft", version: 1, draftedAfterUntrusted: true } }),
    milestones: a.milestones.map((m) => ({ ...m, state: "planned", runIds: [], updatedAt: at })),
    gate: a.brief === undefined ? { kind: "none" } : { kind: "brief" },
  }) ?? { milestones: [], gate: { kind: "none" } };
  return withChanged(fresh, [...(fresh.brief === undefined ? [] : ["brief"]), ...(fresh.plan === undefined ? [] : ["plan"])]);
}

/**
 * The project a chat works on: the record's, with an author edit of the
 * file (`file`, as read from `project.json`) taken as an untrusted
 * draft. Nothing but the author content is read from `file`.
 */
export function resolveProject(file: ProjectState, record: ProjectRecord | null, now: number): ProjectState {
  if (record === null) return freshFromContent(file);
  let state = record.state;
  const labels = [...(state.changedOutside ?? [])];
  const fileAuthor = authorContent(file);
  if (fileAuthor.brief !== undefined && briefPart(fileAuthor) !== briefPart(authorContent(state))) {
    const r = applyProjectUpdate(state, { kind: "brief", brief: fileAuthor.brief as never, draftedAfterUntrusted: true }, now);
    if (r.ok) {
      state = r.project;
      labels.push("brief");
    }
  }
  if (fileAuthor.plan !== undefined && planPart(fileAuthor) !== planPart(authorContent(state))) {
    const r = applyProjectUpdate(state, {
      kind: "plan",
      milestones: fileAuthor.milestones,
      rows: fileAuthor.plan.rows,
      detail: fileAuthor.plan.detail,
      draftedAfterUntrusted: true,
    }, now);
    if (r.ok) {
      state = r.project;
      labels.push("plan");
    }
  }
  return withChanged(state, labels);
}

// ---------------------------------------------------------------- store

export interface ProjectRecordProblem {
  code: "already-decided" | "conflict" | "locked" | "io" | "damaged" | "unsupported";
  message: string;
}

export type ProjectRecordRead = { ok: true; record: ProjectRecord | null } | { ok: false; problem: ProjectRecordProblem };

/**
 * Where a project's record is kept: the one seam between the folder's
 * content and the runtime's state and the person's decisions. A write is
 * made while the project folder's lock is held (`project-store.ts`).
 */
export interface ProjectRecordStore {
  read(folder: string, id: string): ProjectRecordRead;
  /**
   * Record `next` on top of `baseSeq`, with `decision` when a person
   * decided (bound to `hash`, the content its gate covered). The same
   * gate, version and content decided again is `already-decided`; a
   * record that moved on since `baseSeq` is `conflict`. A person's
   * decision at a gate clears that gate from `changedOutside`.
   */
  write(folder: string, id: string, baseSeq: number, next: ProjectState, decision?: ProjectDecisionInput & { hash: string }): { ok: true; seq: number } | { ok: false; problem: ProjectRecordProblem };
}

/** Whether `decisions` hold one for this gate at this version (any content). */
export function gateDecided(decisions: readonly ProjectDecisionRecord[], gate: ProjectGate, version: number): boolean {
  return decisions.some((d) => sameGate(d.gate, gate) && d.version === version);
}

function sameGate(a: ProjectGate, b: ProjectGate): boolean {
  return a.kind === b.kind && (a.kind !== "milestone" || (b.kind === "milestone" && a.id === b.id));
}

/** `<stateDir>/project-decisions`: one record file per project. */
export function projectRecordsDir(stateDir: string): string {
  return join(stateDir, "project-decisions");
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A folder's identity for its record: its real path (symlinks resolved),
 * `/` separators, case folded on Windows and macOS. A copied or moved
 * folder is another folder, so it has no record: its approvals and
 * execution state do not travel with it.
 */
export function canonicalProjectFolder(folder: string, platform: NodeJS.Platform = process.platform): string {
  let real: string;
  try {
    real = realpathSync.native(folder);
  } catch {
    real = resolve(folder);
  }
  const slashed = real.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return platform === "win32" || platform === "darwin" ? slashed.toLowerCase() : slashed;
}

/** The record's file name: folder and id together, so ids differing by case, or one id in two folders, never share one. */
function recordKey(folder: string, id: string): string {
  return createHash("sha256").update(`${folder}\n${id}`).digest("hex").slice(0, 40);
}

/** Whether `path` lies inside `<stateDir>/fusion-runs` (where runs keep their pictures). */
export function insideFusionRuns(stateDir: string, path: string): boolean {
  const rel = relative(join(stateDir, "fusion-runs"), resolve(path));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** The stored state: the normalized project with its `changedOutside` labels, pictures outside the runs dropped. */
function readState(raw: unknown, stateDir: string): ProjectState | null {
  const normalized = normalizeProject(raw);
  if (normalized === undefined) return null;
  const project: ProjectState = {
    ...normalized,
    milestones: normalized.milestones.map((m) => {
      if (m.attachments === undefined) return m;
      const kept = m.attachments.filter((a) => insideFusionRuns(stateDir, a.path));
      const { attachments: _a, ...rest } = m;
      return kept.length === 0 ? rest : { ...rest, attachments: kept };
    }),
  };
  const changed = (raw as { changedOutside?: unknown }).changedOutside;
  const labels = Array.isArray(changed) ? changed.filter((l): l is string => typeof l === "string" && l.length <= 80) : [];
  return withChanged(project, labels);
}

const VERDICTS: ReadonlySet<string> = new Set(["approve", "edit", "cheaper", "quality", "cancel", "approveOverReview"]);

/** A stored decision checked for shape; null when anything is off (the record is then damaged). */
function readDecision(raw: unknown): ProjectDecisionRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const d = raw as Record<string, unknown>;
  const gate = d.gate as Record<string, unknown> | undefined;
  const gateOk = typeof gate === "object" && gate !== null &&
    (gate.kind === "brief" || gate.kind === "plan" || gate.kind === "none" || (gate.kind === "milestone" && typeof gate.id === "string"));
  if (!gateOk || !Number.isInteger(d.version) || !Number.isInteger(d.seq) || typeof d.at !== "number" || typeof d.hash !== "string" || typeof d.verdict !== "string" || !VERDICTS.has(d.verdict)) return null;
  return {
    seq: d.seq as number,
    at: d.at,
    gate: gate.kind === "milestone" ? { kind: "milestone", id: gate.id as string } : { kind: gate.kind as "brief" | "plan" | "none" },
    version: d.version as number,
    verdict: d.verdict as ProjectVerdict,
    hash: d.hash,
  };
}

function nextRecord(current: ProjectRecord | null, folder: string, id: string, next: ProjectState, decision: (ProjectDecisionInput & { hash: string }) | undefined, at: number): ProjectRecord {
  const seq = (current?.seq ?? 0) + 1;
  // The labels are the record's: only the person's decision at a gate
  // clears it; every other write (a director's redraft) carries them.
  const kept = [...(current?.state.changedOutside ?? []), ...(next.changedOutside ?? [])]
    .filter((l) => decision === undefined || l !== gateLabelOf(decision.gate));
  const decisions = current?.decisions ?? [];
  return {
    version: 1,
    folder,
    id,
    seq,
    state: withChanged(next, kept),
    decisions: decision === undefined ? decisions : [...decisions, { seq, at, ...decision }].slice(-MAX_DECISIONS),
  };
}

function checkWrite(current: ProjectRecord | null, baseSeq: number, decision: (ProjectDecisionInput & { hash: string }) | undefined): ProjectRecordProblem | null {
  if (decision !== undefined && (current?.decisions ?? []).some((d) => sameGate(d.gate, decision.gate) && d.version === decision.version && d.hash === decision.hash)) {
    return { code: "already-decided", message: "That gate was already decided (in another chat); reload the project." };
  }
  if ((current?.seq ?? 0) !== baseSeq) return { code: "conflict", message: "The project's record changed since it was read; reload it." };
  return null;
}

/** The record store under the state dir; `now` for tests. */
export function stateDirProjectRecords(stateDir: string, now: () => number = Date.now, platform: NodeJS.Platform = process.platform): ProjectRecordStore {
  const dir = projectRecordsDir(stateDir);
  const fileOf = (folder: string, id: string) => {
    if (!SAFE_ID.test(id)) throw new Error(`project id ${JSON.stringify(id)} is not a safe file name`);
    return join(dir, `${recordKey(folder, id)}.json`);
  };
  /** `foreign`: the file at this folder's key belongs to another folder or id; it is never replaced. */
  const readAt = (folder: string, id: string): ProjectRecordRead & { foreign?: true } => {
    const file = fileOf(folder, id);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, record: null };
      // A transient error (EBUSY, EPERM, EISDIR) is not an empty record: nothing is approved and nothing is written.
      return { ok: false, problem: { code: "io", message: `the record ${file} could not be read: ${(err as Error).message}` } };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return { ok: false, problem: { code: "damaged", message: `the record ${file} is not valid JSON (${(err as Error).message})` } };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, problem: { code: "damaged", message: `the record ${file} is not a JSON object` } };
    }
    const raw = parsed as Record<string, unknown>;
    if (raw.version !== 1) {
      return { ok: false, problem: { code: "unsupported", message: `the record ${file} has version ${JSON.stringify(raw.version)}; this Atomic Agent reads version 1` } };
    }
    const state = readState(raw.state, stateDir);
    const decisions = Array.isArray(raw.decisions) ? raw.decisions.map(readDecision) : null;
    if (!Number.isInteger(raw.seq) || (raw.seq as number) < 1 || state === null || decisions === null || decisions.some((d) => d === null)) {
      return { ok: false, problem: { code: "damaged", message: `the record ${file} is damaged` } };
    }
    if (raw.folder !== folder || raw.id !== id) return { ok: true, record: null, foreign: true };
    return { ok: true, record: { version: 1, folder, id, seq: raw.seq as number, state, decisions: decisions as ProjectDecisionRecord[] } };
  };
  return {
    read(folder, id) {
      const r = readAt(canonicalProjectFolder(folder, platform), id);
      return r.ok ? { ok: true, record: r.record } : r;
    },
    write(rawFolder, id, baseSeq, next, decision) {
      const folder = canonicalProjectFolder(rawFolder, platform);
      const current = readAt(folder, id);
      if (!current.ok) return current;
      if (current.foreign === true) {
        return { ok: false, problem: { code: "conflict", message: "This folder's record file holds another project's record; it was left as it is." } };
      }
      const refused = checkWrite(current.record, baseSeq, decision);
      if (refused !== null) return { ok: false, problem: refused };
      const out = nextRecord(current.record, folder, id, next, decision, now());
      mkdirSync(dir, { recursive: true });
      const file = fileOf(folder, id);
      const temp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
      try {
        writeFileSync(temp, `${JSON.stringify(out, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        renameSync(temp, file);
      } catch (err) {
        rmSync(temp, { force: true });
        return { ok: false, problem: { code: "io", message: (err as Error).message } };
      }
      return { ok: true, seq: out.seq };
    },
  };
}

/** In-memory records for tests. */
export function memoryProjectRecords(now: () => number = Date.now): ProjectRecordStore & { records: Map<string, ProjectRecord> } {
  const records = new Map<string, ProjectRecord>();
  const key = (folder: string, id: string) => recordKey(canonicalProjectFolder(folder), id);
  return {
    records,
    read: (folder, id) => ({ ok: true, record: records.get(key(folder, id)) ?? null }),
    write(folder, id, baseSeq, next, decision) {
      const current = records.get(key(folder, id)) ?? null;
      const refused = checkWrite(current, baseSeq, decision);
      if (refused !== null) return { ok: false, problem: refused };
      const out = nextRecord(current, canonicalProjectFolder(folder), id, next, decision, now());
      records.set(key(folder, id), out);
      return { ok: true, seq: out.seq };
    },
  };
}
