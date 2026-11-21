import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { gateDecided, type ProjectDecisionInput, type ProjectDecisionStore } from "./project-decisions.js";
import { commitProject, createProject, openProject, projectFilePath, type OpenedProject, type ProjectStoreProblem } from "./project-store.js";
import { withProject, type ProjectGate, type ProjectState } from "./session-project.js";
import type { SessionState } from "./session-state.js";

/**
 * A session's fusion project in its folder store (issue #109). The
 * session keeps a reference (`projectRef`: folder, id, and the revision
 * and decision seq it last read); its `project` is the store's project,
 * read when the session loads and before each turn, and is never saved
 * with the session. Several chats in the same folder share one project.
 *
 * A session saved before the store embeds its project: the first load
 * writes it to the folder (content) and the decision store (its
 * approvals, bound to the current content), then keeps the reference.
 * Until that write succeeds the embedded copy stays in the session row.
 * A folder that already holds another project, or cannot be written,
 * leaves the session as it was (the project stays embedded).
 */

export interface SessionProjectRef {
  folder: string;
  id: string;
  revision: number;
  decisionSeq: number;
}

export interface SessionProjectStoreOptions {
  stateDir: string;
  decisions: ProjectDecisionStore;
  platform?: NodeJS.Platform;
  now?: () => number;
}

export type SessionProjectCommit =
  | { ok: true; session: SessionState }
  | { ok: false; problem: ProjectStoreProblem };

export interface SessionProjectStore {
  /** On load: a reference read from its store, an embedded project migrated to one. */
  load(state: SessionState): SessionState;
  /**
   * Before a turn: `load`, and a session with no project in a folder that
   * holds one is bound to it when the turn runs the project flow.
   */
  prepareTurn(state: SessionState, projectGates: boolean): SessionState;
  /**
   * Write the session's changed project: to its store (compared on the
   * revision and decision seq it read), or a new store for a new project;
   * embedded as before when the session's project could not move there.
   */
  commit(state: SessionState, next: ProjectState, decision?: { input: ProjectDecisionInput; decidedOn: ProjectState }): SessionProjectCommit;
  /** Whether the decision store holds a decision on this gate at this version for the session's project. */
  decided(state: SessionState, gate: ProjectGate, version: number): boolean;
}

/** The folder a session's project lives in: the worktree's original folder, else the working dir. */
export function projectFolderOf(state: Pick<SessionState, "workingDir" | "worktree">): string {
  return resolve(state.worktree?.originalWorkingDir ?? state.workingDir);
}

/** Folder identity: case-insensitive on Windows and macOS. */
export function sameProjectFolder(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const fold = (p: string) => {
    const r = resolve(p).replace(/[\\/]+$/, "");
    return platform === "win32" || platform === "darwin" ? r.toLowerCase().replace(/\\/g, "/") : r;
  };
  return fold(a) === fold(b);
}

/** The reference a session holds, read leniently (a malformed one is none). */
export function readProjectRef(state: { projectRef?: unknown }): SessionProjectRef | null {
  const r = state.projectRef as Partial<SessionProjectRef> | undefined;
  if (r === undefined || r === null || typeof r !== "object") return null;
  if (typeof r.folder !== "string" || typeof r.id !== "string") return null;
  return {
    folder: r.folder,
    id: r.id,
    revision: Number.isInteger(r.revision) ? (r.revision as number) : 0,
    decisionSeq: Number.isInteger(r.decisionSeq) ? (r.decisionSeq as number) : 0,
  };
}

function bound(state: SessionState, opened: OpenedProject): SessionState {
  const { projectProblem: _p, ...rest } = state;
  return {
    ...rest,
    project: opened.project,
    projectRef: { folder: opened.stored.folder, id: opened.stored.id, revision: opened.stored.revision, decisionSeq: opened.decisionSeq },
  };
}

function unavailable(state: SessionState, message: string): SessionState {
  const rest = withProject(state, undefined);
  return { ...rest, projectProblem: message };
}

export function createSessionProjectStore(options: SessionProjectStoreOptions): SessionProjectStore {
  const storeOptions = { stateDir: options.stateDir, decisions: options.decisions, ...(options.now === undefined ? {} : { now: options.now }) };
  const open = (state: SessionState, ref: SessionProjectRef): SessionState => {
    // The project is the session's folder's: a reference to another folder
    // would carry its content past that folder's constraints.
    if (!sameProjectFolder(ref.folder, projectFolderOf(state), options.platform)) {
      return unavailable(state, `This chat's project is in ${ref.folder}, not in the chat's folder; it was not opened.`);
    }
    const opened = openProject(ref.folder, storeOptions);
    if (!opened.ok) return unavailable(state, opened.problem.message);
    if (opened.opened.stored.id !== ref.id) {
      return unavailable(state, `${projectFilePath(ref.folder)} now holds another project (${opened.opened.stored.id}); this chat's project ${ref.id} was not opened.`);
    }
    return bound(state, opened.opened);
  };
  const migrate = (state: SessionState, project: ProjectState): SessionState => {
    const folder = projectFolderOf(state);
    if (existsSync(projectFilePath(folder))) return state;
    const created = createProject(folder, project, storeOptions);
    return created.ok ? bound(state, created.opened) : state;
  };
  const load = (state: SessionState): SessionState => {
    const ref = readProjectRef(state);
    if (ref !== null) return open(state, ref);
    if (state.project !== undefined) return migrate(state, state.project);
    return state;
  };
  return {
    load,
    prepareTurn(state, projectGates) {
      const loaded = load(state);
      if (!projectGates || loaded.project !== undefined || readProjectRef(loaded) !== null) return loaded;
      const folder = projectFolderOf(loaded);
      if (!existsSync(projectFilePath(folder))) return loaded;
      const opened = openProject(folder, storeOptions);
      return opened.ok ? bound(loaded, opened.opened) : { ...loaded, projectProblem: opened.problem.message };
    },
    decided(state, gate, version) {
      const ref = readProjectRef(state);
      return ref !== null && gateDecided(options.decisions.read(ref.id).decisions, gate, version);
    },
    commit(state, next, decision) {
      const ref = readProjectRef(state);
      const extra = decision === undefined ? {} : { decision: decision.input, decidedOn: decision.decidedOn };
      if (ref !== null) {
        const written = commitProject(ref.folder, ref.id, ref, next, { ...storeOptions, ...extra });
        return written.ok ? { ok: true, session: bound(state, written.opened) } : { ok: false, problem: written.problem };
      }
      if (state.projectProblem !== undefined) return { ok: false, problem: { code: "refused", message: state.projectProblem } };
      if (state.project !== undefined) {
        // Embedded and not migrated (the folder holds another project, or
        // cannot be written): the project stays in the session.
        return { ok: true, session: withProject(state, next) };
      }
      const created = createProject(projectFolderOf(state), next, storeOptions);
      if (created.ok) return { ok: true, session: bound(state, created.opened) };
      if (created.problem.code === "exists") {
        return { ok: false, problem: { code: "exists", message: `${created.problem.message} Reopen the chat to work on it.` } };
      }
      // A folder the store cannot be written in keeps the project in the session.
      return { ok: true, session: withProject(state, next) };
    },
  };
}
