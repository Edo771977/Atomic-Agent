import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

import { getConfig } from "../config/index.js";
import { stateDirDecisionStore } from "../session/project-decisions.js";
import { formatProjectGateText } from "../session/project-gate-text.js";
import { forgetProjectFolder, readProjectRegistry } from "../session/project-registry.js";
import { openProject, projectFilePath } from "../session/project-store.js";
import { describeExpectation, gateLabel } from "../session/project-store-views.js";
import { projectExpectation, type ProjectState } from "../session/session-project.js";
import { projectStoreForStateDir, readProjectRef, type SessionProjectStore } from "../session/session-project-store.js";
import { createEmptySessionState, type SessionState } from "../session/session-state.js";
import { SessionStore } from "../session/session-store.js";
import { projectGateView } from "../tools/fusion/project-gate-view.js";
import { FUSION_RUNS_DIR_NAME, FusionRunStore } from "../tools/fusion/run-checkpoint.js";

/**
 * `atomic-agent projects list` and `atomic-agent project resume <folder>`
 * (issue #109): the fusion projects this machine knows, read from each
 * folder's `.atomic/project/project.json` with the person's decisions
 * from the state dir; and a chat opened on one folder's project, showing
 * what waits for the person.
 */

const PROJECTS_HELP = [
  "atomic-agent projects — the fusion projects this computer knows",
  "",
  "Subcommands:",
  "  list [--json]        Name, folder, what waits for you, what happens next, last change and spend",
  "  forget <folder>      Drop a folder from the list (its project stays in the folder)",
  "",
].join("\n");

const PROJECT_HELP = [
  "atomic-agent project — one fusion project",
  "",
  "Subcommands:",
  "  resume <folder> [--no-open]",
  "      Open a chat on the folder's project and show the gate waiting for you;",
  "      --no-open only prints it and the chat to continue.",
  "",
].join("\n");

export interface ProjectsCommandIo {
  stateDir?: () => string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export interface ProjectRow {
  folder: string;
  status: "ok" | "missing" | "damaged" | "unsupported" | "unreadable";
  name?: string;
  id?: string;
  gate?: string;
  next?: string;
  updatedAt?: number;
  /** Priced spend of the project's fusion runs still on disk; null when none were found. */
  spentUsd?: number | null;
  problem?: string;
}

/** Spend of the runs the project's milestones record, from their checkpoints. */
function projectSpend(project: ProjectState, stateDir: string): number | null {
  const runs = new FusionRunStore({ dir: join(stateDir, FUSION_RUNS_DIR_NAME) });
  const ids = new Set(project.milestones.flatMap((m) => [...m.runIds, ...(m.history ?? []).flatMap((h) => h.runIds)]));
  let total: number | null = null;
  for (const id of ids) {
    const checkpoint = runs.load(id);
    if (checkpoint !== null) total = (total ?? 0) + checkpoint.spentUsd;
  }
  return total === null ? null : Math.round(total * 1e4) / 1e4;
}

/** One row per known folder; a missing or damaged folder is a row, never an error. */
export function listProjectRows(stateDir: string): { rows: ProjectRow[]; registryProblem?: string } {
  const registry = readProjectRegistry(stateDir);
  if (!registry.ok) return { rows: [], registryProblem: registry.message };
  const decisions = stateDirDecisionStore(stateDir);
  const rows = registry.folders.map((folder): ProjectRow => {
    const opened = openProject(folder, { stateDir, decisions });
    if (!opened.ok) {
      const code = opened.problem.code;
      const status = code === "missing" ? "missing" : code === "damaged" ? "damaged" : code === "unsupported-schema" ? "unsupported" : "unreadable";
      return { folder, status, problem: opened.problem.message };
    }
    const { stored, project } = opened.opened;
    return {
      folder,
      status: "ok",
      name: stored.name,
      id: stored.id,
      gate: gateLabel(project),
      next: describeExpectation(projectExpectation(project)),
      updatedAt: stored.updatedAt,
      spentUsd: projectSpend(project, stateDir),
    };
  });
  return { rows };
}

function formatRows(rows: readonly ProjectRow[]): string {
  if (rows.length === 0) return "No fusion projects yet. A project starts when a chat's director drafts a brief.\n";
  const out: string[] = [];
  for (const r of rows) {
    if (r.status !== "ok") {
      out.push(`${r.folder}`, `  ${r.status}: ${r.problem ?? ""}`, "");
      continue;
    }
    out.push(
      `${r.name}  (${r.folder})`,
      `  waiting on: ${r.gate}`,
      `  next: ${r.next}`,
      `  last change: ${new Date(r.updatedAt!).toISOString()}`,
      `  spend: ${r.spentUsd === null || r.spentUsd === undefined ? "no recorded runs" : `$${r.spentUsd.toFixed(2)}`}`,
      "",
    );
  }
  return `${out.join("\n").trimEnd()}\n`;
}

/** `atomic-agent projects …`: 0 done, 1 the list could not be read, 2 usage. */
export async function projectsCommand(args: string[], io: ProjectsCommandIo = {}): Promise<number> {
  const stdout = io.stdout ?? ((t: string) => void process.stdout.write(t));
  const stderr = io.stderr ?? ((t: string) => void process.stderr.write(t));
  const sub = args[0];
  if (sub === undefined || sub === "-h" || sub === "--help") {
    stdout(PROJECTS_HELP);
    return 0;
  }
  const stateDir = io.stateDir?.() ?? getConfig().paths.stateDir;
  if (sub === "list") {
    const rest = args.slice(1);
    const json = rest.includes("--json");
    if (rest.some((a) => a !== "--json")) {
      stderr(`projects list: unknown argument ${rest.find((a) => a !== "--json")}\n`);
      return 2;
    }
    const listed = listProjectRows(stateDir);
    if (listed.registryProblem !== undefined) {
      stderr(`projects list: ${listed.registryProblem}\n`);
      return 1;
    }
    stdout(json ? `${JSON.stringify(listed.rows, null, 2)}\n` : formatRows(listed.rows));
    return 0;
  }
  if (sub === "forget") {
    const folder = args[1];
    if (folder === undefined || args.length > 2) {
      stderr("projects forget: needs one folder\n");
      return 2;
    }
    const forgot = forgetProjectFolder(stateDir, resolve(folder));
    stdout(forgot ? `forgot ${resolve(folder)} (its project stays in the folder)\n` : `${resolve(folder)} was not listed\n`);
    return 0;
  }
  stderr(`unknown subcommand: ${sub}\n${PROJECTS_HELP}`);
  return 2;
}

export interface ProjectCommandDeps extends ProjectsCommandIo {
  /** The session store to open the chat in; closed by the caller when given. */
  sessionStore?: SessionStore;
  projectStore?: SessionProjectStore;
  /** Open the chat for the person (the TUI on `--session <id>`); absent or `--no-open`: print only. */
  openChat?: (sessionId: string) => Promise<number>;
  newSessionId?: () => string;
}

/** The newest chat in `folder` on project `id`, if any. */
function chatOnProject(store: SessionStore, folder: string, id: string): SessionState | null {
  for (const s of store.listByWorkingDir(folder, 50)) {
    if (readProjectRef(s)?.id === id) return s;
  }
  return null;
}

/** `atomic-agent project resume <folder>`: 0 done, 1 the project could not be opened, 2 usage. */
export async function projectCommand(args: string[], deps: ProjectCommandDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? ((t: string) => void process.stdout.write(t));
  const stderr = deps.stderr ?? ((t: string) => void process.stderr.write(t));
  const sub = args[0];
  if (sub === undefined || sub === "-h" || sub === "--help") {
    stdout(PROJECT_HELP);
    return 0;
  }
  if (sub !== "resume") {
    stderr(`unknown subcommand: ${sub}\n${PROJECT_HELP}`);
    return 2;
  }
  const rest = args.slice(1);
  const noOpen = rest.includes("--no-open");
  const positional = rest.filter((a) => a !== "--no-open");
  if (positional.length !== 1 || positional[0]!.startsWith("-")) {
    stderr("project resume: needs one folder\n");
    return 2;
  }
  const folder = resolve(positional[0]!);
  const config = deps.stateDir === undefined ? getConfig() : null;
  const stateDir = deps.stateDir?.() ?? config!.paths.stateDir;
  const projects = deps.projectStore ?? projectStoreForStateDir(stateDir);
  const opened = openProject(folder, { stateDir, decisions: stateDirDecisionStore(stateDir) });
  if (!opened.ok) {
    stderr(`project resume: ${opened.problem.message}\n`);
    return 1;
  }
  const store = deps.sessionStore ?? new SessionStore({ dbFile: (config ?? getConfig()).paths.sessionsDbFile, projectStore: projects });
  try {
    const existing = chatOnProject(store, folder, opened.opened.stored.id);
    let session = existing ?? projects.prepareTurn(
      createEmptySessionState({ id: (deps.newSessionId ?? (() => `s-${randomUUID()}`))(), workingDir: folder }),
      true,
    );
    if (existing === null) {
      if (session.project === undefined) {
        stderr(`project resume: ${session.projectProblem ?? `the project in ${projectFilePath(folder)} could not be opened`}\n`);
        return 1;
      }
      store.save(session);
    } else {
      session = projects.load(session);
    }
    const project = session.project ?? opened.opened.project;
    stdout(`${opened.opened.stored.name}  (${folder})\n`);
    if (project.gate.kind === "none") {
      stdout(`Nothing waits for you. Next: ${describeExpectation(projectExpectation(project))}.\n`);
    } else {
      const view = projectGateView({ sessionId: session.id, project, estimate: null, selectable: { workers: [], reviewers: [] } });
      stdout(`${formatProjectGateText(view)}\n`);
      if (view.version !== null) stdout(`Approve with: atomic-agent run --session ${session.id} --approve ${view.version}\n`);
    }
    stdout(`chat: ${session.id}${existing === null ? " (new)" : ""}\nContinue with: atomic-agent tui --session ${session.id}\n`);
    if (noOpen || deps.openChat === undefined) return 0;
    return await deps.openChat(session.id);
  } finally {
    if (deps.sessionStore === undefined) store.close();
  }
}
