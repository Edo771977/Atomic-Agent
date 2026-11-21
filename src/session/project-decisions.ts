import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  normalizeProject,
  type AssignmentRow,
  type MilestoneCorrection,
  type ProjectCriterion,
  type ProjectGate,
  type ProjectMilestone,
  type ProjectReviewBlock,
  type ProjectState,
  type ProjectVerdict,
} from "./session-project.js";

/**
 * Person decisions on a fusion project's gates (issue #109), kept apart
 * from the project's content. `project.json` in the project folder holds
 * only content (brief, plan, milestones, evidence); the person's
 * approvals live in the user's state dir, keyed by project id, each bound
 * to the hash of the content its gate covers. A gate counts as approved
 * only while that content is unchanged, so a file edited by hand or by a
 * model's shell command cannot approve anything: the changed gate (and
 * every gate that depends on it) waits for the person again.
 *
 * Covered content ({@link coveredHashes}):
 *  - brief gate: the whole brief as content (version, what, users, how,
 *    game, criteria, untrusted flag).
 *  - plan gate: the plan's rows (worker, reviewer, estimates, tasks,
 *    milestone of each), its detail and untrusted flag, and the
 *    milestones' ids, titles and kinds. Not its version, which a
 *    milestone report bumps without changing the plan.
 *  - milestone gate: one milestone's id, title, kind, reported outcome
 *    (state as the director left it), runs, summary, pictures, criteria
 *    facts, review blocks and held corrections, with the plan rows of its
 *    tasks.
 * A plan approval stands only while the brief approval stands; a
 * milestone verdict only while the plan approval stands.
 */

/** What a person decided, as the decision store records it. */
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

/** The person-owned part of one milestone. */
interface MilestoneDecisionState {
  state: ProjectMilestone["state"];
  reviewOverride?: ProjectMilestone["reviewOverride"];
  corrections?: MilestoneCorrection[];
}

/** The person-owned part of a project, and the content hashes it was recorded over. */
export interface ProjectDecisionOverlay {
  briefStatus?: "draft" | "approved";
  briefApprovedAt?: number;
  planStatus?: "draft" | "approved" | "cancelled";
  planApprovedAt?: number;
  planApprovedWithUntrustedWarning?: true;
  milestones: Record<string, MilestoneDecisionState>;
  gate: ProjectGate;
  approvedCriteria?: ProjectCriterion[];
  briefApprovals?: number;
  cancelledAt?: number;
  versionFloor?: number;
  /** Versions recorded, so a gate reopened by changed content gets a higher one. */
  versions: { brief?: number; plan?: number };
  hashes: { brief?: string; plan?: string; milestones: Record<string, string> };
}

/** One project's decision file. */
export interface ProjectDecisionFile {
  version: 1;
  id: string;
  /** +1 on every write; a write names the one it builds on. */
  seq: number;
  overlay: ProjectDecisionOverlay | null;
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

/** A milestone's outcome as content: the person's `approved` reads as `planned`, `reviewed` as `done`. */
function contentState(state: ProjectMilestone["state"]): ProjectMilestone["state"] {
  if (state === "approved") return "planned";
  if (state === "reviewed") return "done";
  return state;
}

/**
 * The project with every person decision taken out: what `project.json`
 * holds. Brief and plan read as drafts, approvals and corrections are
 * gone, the gate is `none` (the decision store and the rules put it back).
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
      return { ...rest, state: contentState(m.state) };
    }),
    gate: { kind: "none" },
  };
}

function rowsOf(rows: readonly AssignmentRow[] | undefined, milestoneId?: string): AssignmentRow[] {
  return (rows ?? []).filter((r) => milestoneId === undefined || r.milestoneId === milestoneId);
}

/** Hashes of what each gate covers, over `project`'s content. */
export function coveredHashes(project: ProjectState): ProjectDecisionOverlay["hashes"] {
  const content = projectContent(project);
  const milestones: Record<string, string> = {};
  for (const m of content.milestones) {
    const { updatedAt: _u, history: _h, ...rest } = m;
    milestones[m.id] = sha({ milestone: rest, rows: rowsOf(content.plan?.rows, m.id) });
  }
  return {
    ...(content.brief === undefined ? {} : { brief: sha(content.brief) }),
    ...(content.plan === undefined
      ? {}
      : {
          plan: sha({
            rows: content.plan.rows,
            detail: content.plan.detail,
            draftedAfterUntrusted: content.plan.draftedAfterUntrusted,
            milestones: content.milestones.map((m) => ({ id: m.id, title: m.title, kind: m.kind })),
          }),
        }),
    milestones,
  };
}

/** The hash a decision at `gate` covers in `project`; null when the gate names nothing there. */
export function gateContentHash(project: ProjectState, gate: ProjectGate): string | null {
  const hashes = coveredHashes(project);
  if (gate.kind === "brief") return hashes.brief ?? null;
  if (gate.kind === "plan") return hashes.plan ?? null;
  if (gate.kind === "milestone") return hashes.milestones[gate.id] ?? null;
  return hashes.plan ?? hashes.brief ?? null;
}

/** The person-owned part of `project`, over the content it stands on. */
export function decisionOverlay(project: ProjectState): ProjectDecisionOverlay {
  const milestones: Record<string, MilestoneDecisionState> = {};
  for (const m of project.milestones) {
    milestones[m.id] = {
      state: m.state,
      ...(m.reviewOverride === undefined ? {} : { reviewOverride: m.reviewOverride }),
      ...(m.corrections === undefined ? {} : { corrections: m.corrections }),
    };
  }
  return {
    ...(project.brief === undefined ? {} : { briefStatus: project.brief.status }),
    ...(project.brief?.approvedAt === undefined ? {} : { briefApprovedAt: project.brief.approvedAt }),
    ...(project.plan === undefined ? {} : { planStatus: project.plan.status }),
    ...(project.plan?.approvedAt === undefined ? {} : { planApprovedAt: project.plan.approvedAt }),
    ...(project.plan?.approvedWithUntrustedWarning === true ? { planApprovedWithUntrustedWarning: true as const } : {}),
    milestones,
    gate: project.gate,
    ...(project.approvedCriteria === undefined ? {} : { approvedCriteria: project.approvedCriteria }),
    ...(project.briefApprovals === undefined ? {} : { briefApprovals: project.briefApprovals }),
    ...(project.cancelledAt === undefined ? {} : { cancelledAt: project.cancelledAt }),
    ...(project.versionFloor === undefined ? {} : { versionFloor: project.versionFloor }),
    versions: {
      ...(project.brief === undefined ? {} : { brief: project.brief.version }),
      ...(project.plan === undefined ? {} : { plan: project.plan.version }),
    },
    hashes: coveredHashes(project),
  };
}

/**
 * The project `content` (as `project.json` holds it) with the recorded
 * decisions applied where the content they covered is unchanged. With no
 * record (a new machine) every gate waits for the person. A gate whose
 * content changed since it was decided reopens at a higher version and is
 * listed in `changedOutside` (`brief`, `plan`, `milestone:<id>`), so an
 * automatic path can tell it apart from a gate the rules opened.
 */
export function resolveProject(content: ProjectState, overlay: ProjectDecisionOverlay | null): ProjectState {
  const base = projectContent(content);
  const hashes = coveredHashes(base);
  const o = overlay;
  const changed: string[] = [];
  const briefSame = base.brief !== undefined && o?.hashes.brief === hashes.brief;
  if (base.brief !== undefined && !briefSame) changed.push("brief");
  const briefApproved = briefSame && o?.briefStatus === "approved";
  const planSame = base.plan !== undefined && o?.hashes.plan === hashes.plan;
  // A plan approval stands on the brief approval it followed.
  const planHolds = planSame && (briefApproved || o?.planStatus !== "approved");
  if (base.plan !== undefined && !planHolds && o?.planStatus !== "cancelled") changed.push("plan");
  const planApproved = planHolds && o?.planStatus === "approved";
  const cancelled = o?.cancelledAt !== undefined;

  const milestones: ProjectMilestone[] = base.milestones.map((m) => {
    const recorded = o?.milestones[m.id];
    const same = recorded !== undefined && o?.hashes.milestones[m.id] === hashes.milestones[m.id];
    const notes = recorded?.corrections === undefined ? {} : { corrections: recorded.corrections };
    if (same) {
      // A milestone the person let run runs only under a standing plan approval.
      const state = !planApproved && !cancelled && recorded.state === "approved" ? "planned" : recorded.state;
      return { ...m, state, ...notes, ...(recorded.reviewOverride === undefined ? {} : { reviewOverride: recorded.reviewOverride }) };
    }
    if (recorded !== undefined && !same) changed.push(`milestone:${m.id}`);
    return { ...m, ...notes };
  });

  const nextVersion = (current: number, recorded: number | undefined) => Math.max(current, recorded ?? 0, o?.versionFloor ?? 0) + 1;
  const brief = base.brief === undefined
    ? undefined
    : briefSame && o !== null
      ? { ...base.brief, status: o.briefStatus ?? "draft", ...(o.briefStatus === "approved" && o.briefApprovedAt !== undefined ? { approvedAt: o.briefApprovedAt } : {}) }
      : { ...base.brief, version: o === null ? base.brief.version : nextVersion(base.brief.version, o.versions.brief) };
  const plan = base.plan === undefined
    ? undefined
    : cancelled && o?.planStatus === "cancelled"
      ? { ...base.plan, status: "cancelled" as const }
      : planHolds && o !== null
        ? {
            ...base.plan,
            status: o.planStatus === "approved" ? ("approved" as const) : ("draft" as const),
            ...(planApproved && o.planApprovedAt !== undefined ? { approvedAt: o.planApprovedAt } : {}),
            ...(planApproved && o.planApprovedWithUntrustedWarning === true ? { approvedWithUntrustedWarning: true as const } : {}),
          }
        : { ...base.plan, version: o === null ? base.plan.version : nextVersion(base.plan.version, o.versions.plan) };
  // A milestone gate decides against the plan's version: changed evidence
  // must not be approvable from a card shown before the change.
  if (plan !== undefined && planHolds && o !== null && changed.some((c) => c.startsWith("milestone:"))) {
    plan.version = nextVersion(plan.version, o.versions.plan);
  }

  const gate = ((): ProjectGate => {
    if (cancelled) return { kind: "none" };
    if (brief !== undefined && changed.includes("brief")) return { kind: "brief" };
    if (o === null) return brief === undefined ? { kind: "none" } : { kind: "brief" };
    if (plan !== undefined && brief?.status === "approved" && changed.includes("plan")) return { kind: "plan" };
    const reopened = milestones.find((m) => changed.includes(`milestone:${m.id}`) && (m.state === "done" || m.state === "failed"));
    if (reopened !== undefined && plan?.status === "approved") return { kind: "milestone", id: reopened.id };
    if (changed.length === 0) return o.gate;
    if (o.gate.kind === "brief" && brief !== undefined) return o.gate;
    if (o.gate.kind === "plan" && plan !== undefined && plan.status === "draft") return o.gate;
    if (o.gate.kind === "milestone" && plan?.status === "approved" && milestones.some((m) => m.id === (o.gate as { id: string }).id)) return o.gate;
    return { kind: "none" };
  })();

  const resolved = normalizeProject({
    ...(brief === undefined ? {} : { brief }),
    ...(plan === undefined ? {} : { plan }),
    milestones,
    gate,
    ...(o?.approvedCriteria === undefined ? {} : { approvedCriteria: o.approvedCriteria }),
    ...(o?.briefApprovals === undefined ? {} : { briefApprovals: o.briefApprovals }),
    ...(o?.cancelledAt === undefined ? {} : { cancelledAt: o.cancelledAt }),
    ...(o?.versionFloor === undefined ? {} : { versionFloor: o.versionFloor }),
  }) ?? normalizeProject({ ...base, gate: { kind: "none" } }) ?? base;
  const outside = o !== null ? changed : [...(brief === undefined ? [] : ["brief"]), ...(plan === undefined ? [] : ["plan"])];
  return outside.length === 0 ? resolved : { ...resolved, changedOutside: outside };
}

// ---------------------------------------------------------------- store

export interface ProjectDecisionProblem {
  code: "already-decided" | "conflict" | "locked" | "io" | "damaged";
  message: string;
}

export interface ProjectDecisionRead {
  /** The file's `seq`; 0 when nothing was recorded on this machine. */
  seq: number;
  overlay: ProjectDecisionOverlay | null;
  decisions: readonly ProjectDecisionRecord[];
}

/**
 * Where a project's person decisions are kept and how they are checked:
 * the one seam between the content store and the approval design.
 */
export interface ProjectDecisionStore {
  read(id: string): ProjectDecisionRead;
  /**
   * Record `next`'s person-owned state on top of `baseSeq`, with
   * `decision` when a person decided (bound to `decidedHash`, the
   * content its gate covered). A decision already recorded for the same
   * gate, version and content is `already-decided`; a file that moved on
   * since `baseSeq` is `conflict`.
   */
  record(id: string, baseSeq: number, next: ProjectState, decision?: ProjectDecisionInput & { hash: string }): { ok: true; seq: number } | { ok: false; problem: ProjectDecisionProblem };
}

/** Whether `decisions` hold one for this gate at this version (any content). */
export function gateDecided(decisions: readonly ProjectDecisionRecord[], gate: ProjectGate, version: number): boolean {
  return decisions.some((d) => sameGate(d.gate, gate) && d.version === version);
}

function sameGate(a: ProjectGate, b: ProjectGate): boolean {
  return a.kind === b.kind && (a.kind !== "milestone" || (b.kind === "milestone" && a.id === b.id));
}

/** `<stateDir>/project-decisions`: one `<id>.json` per project. */
export function projectDecisionsDir(stateDir: string): string {
  return join(stateDir, "project-decisions");
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The decision store under the state dir; `now` for tests. */
export function stateDirDecisionStore(stateDir: string, now: () => number = Date.now): ProjectDecisionStore {
  const dir = projectDecisionsDir(stateDir);
  const fileOf = (id: string) => {
    if (!SAFE_ID.test(id)) throw new Error(`project id ${JSON.stringify(id)} is not a safe file name`);
    return join(dir, `${id}.json`);
  };
  const readFile = (id: string): ProjectDecisionFile | { damaged: string } => {
    const file = fileOf(id);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, id, seq: 0, overlay: null, decisions: [] };
      return { damaged: (err as Error).message };
    }
    try {
      const raw = JSON.parse(text) as ProjectDecisionFile;
      if (raw?.version !== 1 || raw.id !== id || !Number.isInteger(raw.seq) || !Array.isArray(raw.decisions)) return { damaged: "unexpected shape" };
      return raw;
    } catch (err) {
      return { damaged: (err as Error).message };
    }
  };
  return {
    read(id) {
      const file = readFile(id);
      // A damaged record approves nothing: every gate waits for the person.
      if ("damaged" in file) return { seq: -1, overlay: null, decisions: [] };
      return { seq: file.seq, overlay: file.overlay, decisions: file.decisions };
    },
    record(id, baseSeq, next, decision) {
      mkdirSync(dir, { recursive: true });
      const lock = `${fileOf(id)}.lock`;
      const deadline = Date.now() + 2_000;
      for (;;) {
        try {
          closeSync(openSync(lock, "wx"));
          break;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") return { ok: false, problem: { code: "io", message: (err as Error).message } };
          try {
            if (Date.now() - statSync(lock).mtimeMs > 30_000) rmSync(lock, { force: true });
          } catch {
            // Gone already.
          }
          if (Date.now() >= deadline) return { ok: false, problem: { code: "locked", message: "Another Atomic Agent is recording a decision on this project; try again." } };
          sleepSync(25);
        }
      }
      try {
        const read = readFile(id);
        // A damaged record is replaced: it approved nothing anyway.
        const current: ProjectDecisionFile = "damaged" in read ? { version: 1, id, seq: baseSeq < 0 ? -1 : 0, overlay: null, decisions: [] } : read;
        if (decision !== undefined && current.decisions.some((d) => sameGate(d.gate, decision.gate) && d.version === decision.version && d.hash === decision.hash)) {
          return { ok: false, problem: { code: "already-decided", message: "That gate was already decided (in another chat); reload the project." } };
        }
        if (current.seq !== baseSeq) {
          return { ok: false, problem: { code: "conflict", message: "The project's decisions changed since it was read; reload it." } };
        }
        const seq = Math.max(current.seq, 0) + 1;
        const { changedOutside: _c, ...clean } = next;
        const decisions = decision === undefined
          ? current.decisions
          : [...current.decisions, { seq, at: now(), gate: decision.gate, version: decision.version, verdict: decision.verdict, hash: decision.hash }].slice(-MAX_DECISIONS);
        const out: ProjectDecisionFile = { version: 1, id, seq, overlay: decisionOverlay(clean), decisions };
        const temp = `${fileOf(id)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
        try {
          writeFileSync(temp, `${JSON.stringify(out, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
          renameSync(temp, fileOf(id));
        } catch (err) {
          rmSync(temp, { force: true });
          return { ok: false, problem: { code: "io", message: (err as Error).message } };
        }
        return { ok: true, seq };
      } finally {
        rmSync(lock, { force: true });
      }
    },
  };
}

/** In-memory store for tests and stores that keep no decisions. */
export function memoryDecisionStore(now: () => number = Date.now): ProjectDecisionStore & { files: Map<string, ProjectDecisionFile> } {
  const files = new Map<string, ProjectDecisionFile>();
  return {
    files,
    read(id) {
      const f = files.get(id);
      return f === undefined ? { seq: 0, overlay: null, decisions: [] } : { seq: f.seq, overlay: f.overlay, decisions: f.decisions };
    },
    record(id, baseSeq, next, decision) {
      const current = files.get(id) ?? { version: 1 as const, id, seq: 0, overlay: null, decisions: [] };
      if (decision !== undefined && current.decisions.some((d) => sameGate(d.gate, decision.gate) && d.version === decision.version && d.hash === decision.hash)) {
        return { ok: false, problem: { code: "already-decided", message: "That gate was already decided (in another chat); reload the project." } };
      }
      if (current.seq !== baseSeq) return { ok: false, problem: { code: "conflict", message: "The project's decisions changed since it was read; reload it." } };
      const seq = current.seq + 1;
      const { changedOutside: _c, ...clean } = next;
      files.set(id, {
        version: 1,
        id,
        seq,
        overlay: decisionOverlay(clean),
        decisions: decision === undefined ? current.decisions : [...current.decisions, { seq, at: now(), ...decision }],
      });
      return { ok: true, seq };
    },
  };
}

export type { ProjectReviewBlock };
