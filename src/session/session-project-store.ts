import { existsSync } from "node:fs";

import { gateDecided, stateDirProjectRecords, type ProjectDecisionInput, type ProjectRecordStore } from "./project-decisions.js";
import { commitProject, createProject, openProject, projectFilePath, type OpenedProject, type ProjectStoreProblem } from "./project-store.js";
import { withProject, type ProjectGate, type ProjectState } from "./session-project.js";
import type { SessionState } from "./session-state.js";
import { projectFolderOf, sameProjectFolder } from "./project-folder.js";
import { isIncognitoSession } from "./incognito.js";
import { registerProjectFolder } from "./project-registry.js";

export { projectFolderOf, sameProjectFolder } from "./project-folder.js";

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
 * leaves the session as it was (the project stays embedded). An
 * incognito chat (ATO-586) never touches the store, the registry or the
 * records: its project stays in the session and goes with it.
 */

export interface SessionProjectRef {
  folder: string;
  id: string;
  revision: number;
  decisionSeq: number;
}

export interface SessionProjectStoreOptions {
  stateDir: string;
  records: ProjectRecordStore;
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
  // Every project a session opens is remembered for `projects list` (paths only).
  const bind = (state: SessionState, opened: OpenedProject): SessionState => {
    registerProjectFolder(options.stateDir, opened.stored.folder, options.platform);
    return bound(state, opened);
  };
  const storeOptions = { stateDir: options.stateDir, records: options.records, ...(options.now === undefined ? {} : { now: options.now }) };
  const open = (state: SessionState, ref: SessionProjectRef): SessionState => {
    // The project is the session's folder's: a reference to another folder
    // would carry its content past that folder's constraints.
    if (!sameProjectFolder(ref.folder, projectFolderOf(state), options.platform)) {
      return unavailable(state, `This chat's project is in ${ref.folder}, not in the chat's folder; it was not opened.`);
    }
    const opened = openProject(ref.folder, storeOptions);
    if (!opened.ok) return unavailable(state, opened.problem.message);
    // Another id in the folder (a copy re-identified on its first write, a
    // file put there by hand): the chat follows the folder. Its record is
    // the folder's, so a foreign file brings no approvals or runs with it.
    return bind(state, opened.opened);
  };
  const migrate = (state: SessionState, project: ProjectState): SessionState => {
    const folder = projectFolderOf(state);
    if (existsSync(projectFilePath(folder))) return state;
    const created = createProject(folder, project, storeOptions);
    return created.ok ? bind(state, created.opened) : state;
  };
  const load = (state: SessionState): SessionState => {
    // An incognito chat leaves nothing behind (ATO-586): its project stays in the session.
    if (isIncognitoSession(state)) return state;
    try {
      return loadUnguarded(state);
    } catch (err) {
      // A chat always opens: whatever went wrong with its project is said, never thrown out of a load.
      return unavailable(state, `The project could not be opened: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const loadUnguarded = (state: SessionState): SessionState => {
    const ref = readProjectRef(state);
    if (ref !== null) return open(state, ref);
    if (state.project !== undefined) return migrate(state, state.project);
    return state;
  };
  return {
    load,
    prepareTurn(state, projectGates) {
      if (isIncognitoSession(state)) return state;
      const loaded = load(state);
      if (!projectGates || loaded.project !== undefined || readProjectRef(loaded) !== null) return loaded;
      const folder = projectFolderOf(loaded);
      if (!existsSync(projectFilePath(folder))) return loaded;
      const opened = openProject(folder, storeOptions);
      return opened.ok ? bind(loaded, opened.opened) : { ...loaded, projectProblem: opened.problem.message };
    },
    decided(state, gate, version) {
      const ref = readProjectRef(state);
      if (ref === null) return false;
      const read = options.records.read(ref.folder, ref.id);
      return read.ok && gateDecided(read.record?.decisions ?? [], gate, version);
    },
    commit(state, next, decision) {
      if (isIncognitoSession(state)) return { ok: true, session: withProject(state, next) };
      const ref = readProjectRef(state);
      const extra = decision === undefined ? {} : { decision: decision.input, decidedOn: decision.decidedOn };
      if (ref !== null) {
        const written = commitProject(ref.folder, ref.id, ref, next, { ...storeOptions, ...extra });
        return written.ok ? { ok: true, session: bind(state, written.opened) } : { ok: false, problem: written.problem };
      }
      if (state.projectProblem !== undefined) return { ok: false, problem: { code: "refused", message: state.projectProblem } };
      if (state.project !== undefined) {
        // Embedded and not migrated (the folder holds another project, or
        // cannot be written): the project stays in the session.
        return { ok: true, session: withProject(state, next) };
      }
      const created = createProject(projectFolderOf(state), next, storeOptions);
      if (created.ok) return { ok: true, session: bind(state, created.opened) };
      if (created.problem.code === "exists") {
        return { ok: false, problem: { code: "exists", message: `${created.problem.message} Reopen the chat to work on it.` } };
      }
      // A folder the store cannot be written in keeps the project in the session.
      return { ok: true, session: withProject(state, next) };
    },
  };
}

/** The store every surface on one state dir shares: records under that state dir. */
export function projectStoreForStateDir(stateDir: string): SessionProjectStore {
  return createSessionProjectStore({ stateDir, records: stateDirProjectRecords(stateDir) });
}
