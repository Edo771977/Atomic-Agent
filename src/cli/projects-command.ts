import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

import { getConfig, resolveStateDir } from "../config/index.js";
import { validProjectLessonId, stateDirProjectRecords } from "../session/project-decisions.js";
import { RECEIPT_KINDS } from "../session/receipt-signing.js";
import { verifyProjectReceiptDetails } from "../session/project-receipts.js";
import { projectLessonStatus, readProjectLessons } from "../session/project-lessons.js";
import { formatProjectGateText } from "../session/project-gate-text.js";
import { forgetProjectFolder, readProjectRegistry } from "../session/project-registry.js";
import { commitProject, openProject, projectFilePath } from "../session/project-store.js";
import { applyBacklogDecision, backlogSourceLabel, backlogStateOf, backlogTakenIn, openBacklog, type ProjectBacklogDecision } from "../session/project-backlog.js";
import { projectAttentionZone, type ProjectAttentionZone } from "../session/project-attention.js";
import { describeExpectation, gateLabel } from "../session/project-store-views.js";
import { projectExpectation, type ProjectState } from "../session/session-project.js";
import { projectStoreForStateDir, readProjectRef, sameProjectFolder, type SessionProjectStore } from "../session/session-project-store.js";
import { createEmptySessionState, type SessionState } from "../session/session-state.js";
import { SessionStore } from "../session/session-store.js";
import { LIVE_SESSION_STATUSES } from "../session/session-retention.js";
import type { ProjectGateView } from "../session/project-gate-view.js";
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

const LESSONS_USAGE = "Usage: atomic-agent project lessons [folder] [--json] [--approve <id>@<fingerprint> | --retire <id> | --reopen <id>]\n";

const PROJECT_HELP = [
  "atomic-agent project — one fusion project",
  "",
  "Subcommands:",
  "  verify [folder] [--json]  Verify the archived evidence receipts (default: current folder)",
  "  backlog [folder] [--json] [--promote <id> | --drop <id> | --reopen <id>]",
  "      List the project's backlog (default: current folder); --promote, --drop",
  "      and --reopen are your calls on an item, kept in this computer's record.",
  "  lessons [folder] [--json] [--approve <id>@<fingerprint> | --retire <id> | --reopen <id>]",
  "      List and decide project lessons (default: current folder)",
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
  /** What it asks of the person (issue #121): a row that is not `ok` is a `problem`. */
  zone: ProjectAttentionZone;
  name?: string;
  id?: string;
  gate?: string;
  next?: string;
  updatedAt?: number;
  /** Priced spend of the project's fusion runs still on disk; null when none were found. */
  spentUsd?: number | null;
  problem?: string;
  /** Said with the row, not a failure (older records of the folder passed over). */
  notices?: string[];
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
export function listProjectRows(
  stateDir: string,
  now: number = Date.now(),
  includeFolder: (folder: string) => boolean = () => true,
): { rows: ProjectRow[]; registryProblem?: string } {
  const registry = readProjectRegistry(stateDir);
  if (!registry.ok) return { rows: [], registryProblem: registry.message };
  const records = stateDirProjectRecords(stateDir);
  const rows = registry.folders.filter(includeFolder).map((folder): ProjectRow => {
    const opened = openProject(folder, { stateDir, records });
    if (!opened.ok) {
      const code = opened.problem.code;
      const status = code === "missing" ? "missing" : code === "damaged" ? "damaged" : code === "unsupported-schema" ? "unsupported" : "unreadable";
      return { folder, status, zone: projectAttentionZone(null, undefined, now), problem: opened.problem.message };
    }
    const { stored, project } = opened.opened;
    return {
      folder,
      status: "ok",
      zone: projectAttentionZone(project, stored.updatedAt, now),
      name: stored.name,
      id: stored.id,
      gate: gateLabel(project),
      next: describeExpectation(projectExpectation(project)),
      updatedAt: stored.updatedAt,
      spentUsd: projectSpend(project, stateDir),
      ...(opened.opened.notices === undefined ? {} : { notices: opened.opened.notices }),
    };
  });
  return { rows };
}

/**
 * `folder` as the list spells it when it is listed, else null: a host
 * resumes only a folder the list named (the CLI takes any folder).
 */
export function listedProjectFolder(stateDir: string, folder: string): string | null {
  const registry = readProjectRegistry(stateDir);
  if (!registry.ok) return null;
  return registry.folders.find((f) => sameProjectFolder(f, folder)) ?? null;
}

function formatRows(rows: readonly ProjectRow[]): string {
  if (rows.length === 0) return "No fusion projects yet. A project starts when a chat's director drafts a brief.\n";
  const out: string[] = [];
  for (const r of rows) {
    if (r.status !== "ok") {
      out.push(`${r.folder}`, `  ${r.status}: ${r.problem ?? ""}`, `  attention: ${r.zone}`, "");
      continue;
    }
    out.push(
      `${r.name}  (${r.folder})`,
      `  waiting on: ${r.gate}`,
      `  attention: ${r.zone}`,
      `  next: ${r.next}`,
      `  last change: ${new Date(r.updatedAt!).toISOString()}`,
      `  spend: ${r.spentUsd === null || r.spentUsd === undefined ? "no recorded runs" : `$${r.spentUsd.toFixed(2)}`}`,
      ...(r.notices ?? []).map((n) => `  note: ${n}`),
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

export interface ResumeProjectDeps {
  stateDir: string;
  sessionStore: SessionStore;
  projectStore: SessionProjectStore;
  newSessionId?: () => string;
}

/** A chat on a folder's project: the newest one on it, or a new one saved now. */
export type ResumedProject =
  | { ok: true; folder: string; name: string; session: SessionState; project: ProjectState; created: boolean }
  | { ok: false; folder: string; problem: string };

/**
 * The chat `project resume` opens on `folder`'s project (issue #109): the
 * newest chat in the folder on that project, or a new chat bound to it and
 * saved. Every surface that resumes a project (the CLI, the sidecar, serve)
 * goes through here, so they open the same chat.
 */
export function resumeProjectChat(folder: string, deps: ResumeProjectDeps): ResumedProject {
  const { stateDir, sessionStore: store, projectStore: projects } = deps;
  const opened = openProject(folder, { stateDir, records: stateDirProjectRecords(stateDir) });
  if (!opened.ok) return { ok: false, folder, problem: opened.problem.message };
  const existing = chatOnProject(store, folder, opened.opened.stored.id);
  let session = existing ?? projects.prepareTurn(
    createEmptySessionState({ id: (deps.newSessionId ?? (() => `s-${randomUUID()}`))(), workingDir: folder }),
    true,
  );
  if (existing === null) {
    if (session.project === undefined) {
      return { ok: false, folder, problem: session.projectProblem ?? `the project in ${projectFilePath(folder)} could not be opened` };
    }
    store.save(session);
  } else {
    session = projects.load(session);
  }
  return { ok: true, folder, name: opened.opened.stored.name, session, project: session.project ?? opened.opened.project, created: existing === null };
}

/** The gate view of a resumed chat without the live team's estimates (no runtime to ask). */
export function resumedGateView(sessionId: string, project: ProjectState): ProjectGateView {
  return projectGateView({ sessionId, project, estimate: null, selectable: { workers: [], reviewers: [] } });
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
  if (sub === "verify") {
    const options = args.slice(1);
    const folders = options.filter(arg => arg !== "--json");
    const json = options.includes("--json");
    if (folders.length > 1 || folders[0]?.startsWith("-") || options.length > folders.length + 1) {
      stderr("Usage: atomic-agent project verify [folder] [--json]\n");
      return 2;
    }
    try {
      const results = verifyProjectReceiptDetails(deps.stateDir?.() ?? getConfig().paths.stateDir, resolve(folders[0] ?? "."));
      const valid = results.filter(result => result.status === "valid").length;
      if (json) {
        stdout(JSON.stringify(results, null, 2) + "\n");
      } else {
        for (const [index, { status, projectId }] of results.entries()) {
          const project = projectId === null ? "project unspecified" : `project ${projectId}`;
          stdout(`Receipt ${index + 1}: ${status} (${project})\n`);
        }
        for (const kind of [...RECEIPT_KINDS, null]) {
          const rows = results.filter(result => result.kind === kind);
          if (rows.length === 0) continue;
          const statuses = ["valid", "hash-mismatch", "bad-signature", "unknown-key", "unsigned", "unknown-kind"] as const;
          const counts = statuses.map(status => `${rows.filter(row => row.status === status).length} ${status}`);
          stdout(`${kind ?? "unknown kind"}: ${counts.join(", ")}\n`);
        }
        stdout(`${results.length} receipts, ${valid} valid, ${results.length - valid} problems.\n`);
        stdout("A process running as the same user with keychain access can sign replacement evidence.\n");
      }
      return valid === results.length ? 0 : 1;
    } catch {
      const error = "Could not read the project's receipt archive.";
      if (json) stdout(JSON.stringify({ error }) + "\n");
      stderr(error + "\n");
      return 1;
    }
  }
  if (sub === "backlog" || sub === "lessons") {
    const run = sub === "backlog" ? backlogCommand : lessonsCommand;
    return run(args.slice(1), {
      stdout,
      stderr,
      stateDir: () => deps.stateDir?.() ?? (sub === "lessons" ? resolveStateDir() : getConfig().paths.stateDir),
      liveTurn: (folder, id) => {
        const store = deps.sessionStore ?? new SessionStore({ dbFile: getConfig().paths.sessionsDbFile });
        try {
          return sub === "lessons" ? store.liveProjectTurn(folder, id) : liveTurnOnProject(store, folder, id);
        } finally {
          if (deps.sessionStore === undefined) store.close();
        }
      },
    });
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
  const precheck = openProject(folder, { stateDir, records: stateDirProjectRecords(stateDir) });
  if (!precheck.ok) {
    stderr(`project resume: ${precheck.problem.message}\n`);
    return 1;
  }
  const store = deps.sessionStore ?? new SessionStore({ dbFile: (config ?? getConfig()).paths.sessionsDbFile, projectStore: projects });
  try {
    const resumed = resumeProjectChat(folder, {
      stateDir,
      sessionStore: store,
      projectStore: projects,
      ...(deps.newSessionId === undefined ? {} : { newSessionId: deps.newSessionId }),
    });
    if (!resumed.ok) {
      stderr(`project resume: ${resumed.problem}\n`);
      return 1;
    }
    const { session, project } = resumed;
    stdout(`${resumed.name}  (${folder})\n`);
    if (project.gate.kind === "none") {
      stdout(`Nothing waits for you. Next: ${describeExpectation(projectExpectation(project))}.\n`);
    } else {
      const view = resumedGateView(session.id, project);
      stdout(`${formatProjectGateText(view)}\n`);
      if (view.version !== null) stdout(`Approve with: atomic-agent run --session ${session.id} --approve ${view.version}\n`);
    }
    stdout(`chat: ${session.id}${resumed.created ? " (new)" : ""}\nContinue with: atomic-agent tui --session ${session.id}\n`);
    if (noOpen || deps.openChat === undefined) return 0;
    return await deps.openChat(session.id);
  } finally {
    if (deps.sessionStore === undefined) store.close();
  }
}

const BACKLOG_CALLS: Readonly<Record<string, ProjectBacklogDecision["state"]>> = { "--promote": "promoted", "--drop": "dropped", "--reopen": "open" };

/**
 * `atomic-agent project backlog [folder]` (issue #111): the folder's
 * backlog with the person's call on each item; `--promote`, `--drop` or
 * `--reopen <id>` is that call, made by the person at the terminal and
 * written to the project's record in the state dir (never to
 * `project.json`). No gate moves. 0 done, 1 refused, 2 usage.
 */
/**
 * A chat on `folder`'s project `id` with a turn really running (the gate
 * path's rule, `runtime.projectDecision`): a stored live status whose
 * owner is alive. Its id, else null. A director or worker shell could
 * otherwise run `project backlog --promote` mid-turn and the next step
 * would read it as the person's call. (The agent sets no marker in the
 * environment of the shells it runs, so that cannot be checked here.)
 */
export function liveTurnOnProject(store: SessionStore, folder: string, id: string): string | null {
  for (const s of store.listByWorkingDir(folder, 200)) {
    if (readProjectRef(s)?.id !== id) continue;
    if (LIVE_SESSION_STATUSES.includes(s.status) && store.liveTurnElsewhere(s.id)) return s.id;
  }
  return null;
}

type ProjectCommandIO = { stdout: (t: string) => void; stderr: (t: string) => void; stateDir: () => string; liveTurn: (folder: string, id: string) => string | null };

async function backlogCommand(
  args: string[],
  io: ProjectCommandIO,
): Promise<number> {
  const usage = () => {
    io.stderr("Usage: atomic-agent project backlog [folder] [--json] [--promote <id> | --drop <id> | --reopen <id>]\n");
    return 2;
  };
  let json = false;
  let call: ProjectBacklogDecision | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") json = true;
    else if (a in BACKLOG_CALLS) {
      const id = args[i + 1];
      if (call !== undefined || id === undefined || id.startsWith("-")) return usage();
      call = { id, state: BACKLOG_CALLS[a]! };
      i += 1;
    } else if (a.startsWith("-")) return usage();
    else positional.push(a);
  }
  if (positional.length > 1) return usage();
  const folder = resolve(positional[0] ?? ".");
  const stateDir = io.stateDir();
  const options = { stateDir, records: stateDirProjectRecords(stateDir) };
  const opened = openProject(folder, options);
  if (!opened.ok) {
    io.stderr(`project backlog: ${opened.problem.message}\n`);
    return 1;
  }
  let project = opened.opened.project;
  if (call !== undefined) {
    // No record here (another machine, a copied folder): a write would start the project over under a new id.
    const record = options.records.read(folder);
    if (!record.ok || record.record === null) {
      io.stderr(`project backlog: this computer has no record of the project in ${folder}; open this project in a chat first (atomic-agent project resume ${folder}).\n`);
      return 1;
    }
    // Between turns only, as a gate decision.
    const live = io.liveTurn(folder, record.record.id);
    if (live !== null) {
      io.stderr(`project backlog: a turn is running on ${live}, a chat on this project; wait for it to finish, then decide.\n`);
      return 1;
    }
    const decided = applyBacklogDecision(project, call);
    if (!decided.ok) {
      io.stderr(`project backlog: ${decided.error.message}\n`);
      return 1;
    }
    const { stored, decisionSeq } = opened.opened;
    const written = commitProject(folder, stored.id, { revision: stored.revision, decisionSeq }, decided.project, options);
    if (!written.ok) {
      io.stderr(`project backlog: ${written.problem.message}\n`);
      return 1;
    }
    project = written.opened.project;
    io.stdout(`${call.id} is ${call.state} now.\n`);
  }
  const items = (project.backlog ?? []).map((b) => {
    const state = backlogStateOf(project, b.id);
    // Issue #146: taken in only while the plan still holds it (or the work citing it ran).
    const plannedIn = state === "promoted" ? backlogTakenIn(project, b.id) : undefined;
    // Issue #146: deferred by the person at the plan gate, so no plan has to take it in.
    const deferred = state === "promoted" && plannedIn === undefined && project.backlogCalls?.[b.id]?.deferred === true;
    return { ...b, state, ...(plannedIn === undefined ? {} : { plannedIn }), ...(deferred ? { deferred: true as const } : {}) };
  });
  if (json) {
    io.stdout(`${JSON.stringify({ folder, open: openBacklog(project).length, items }, null, 2)}\n`);
    return 0;
  }
  if (items.length === 0) {
    io.stdout("The backlog is empty.\n");
    return 0;
  }
  for (const b of items) {
    const from = [`from ${backlogSourceLabel(b)}`, ...(b.origin?.milestoneId === undefined ? [] : [`milestone ${b.origin.milestoneId}`]), ...(b.origin?.taskId === undefined ? [] : [`task ${b.origin.taskId}`])].join(", ");
    const state = b.state !== "promoted" ? b.state : b.plannedIn === undefined ? (b.deferred === true ? "promoted, deferred at the plan gate, not in any plan" : "promoted, not in any plan") : `promoted, taken in by plan v${b.plannedIn}`;
    io.stdout(`${b.id} ${state}  ${b.title}  (${b.condition === undefined ? "" : `seed: ${b.condition}; `}${from})\n`);
    if (b.note !== undefined) io.stdout(`    ${b.note}\n`);
  }
  io.stdout(`${openBacklog(project).length} open. Promote, drop or reopen one with --promote, --drop or --reopen <id>.\n`);
  return 0;
}

function lessonsCommand(args: string[], io: ProjectCommandIO): number {
  const { stdout, stderr } = io;
  if (args.includes("--help") || args.includes("-h")) {
    stdout(LESSONS_USAGE + "List and decide the project's Markdown lessons. Defaults to the current folder. Decide between turns.\n");
    return 0;
  }
  const usage = () => {
    stderr(LESSONS_USAGE);
    return 2;
  };
  const refuse = (message: string) => {
    stderr("project lessons: " + message + "\n");
    return 1;
  };
  const actions = { "--approve": "approved", "--retire": "retired", "--reopen": null } as const;
  let json = false;
  let decision: { id: string; state: "approved" | "retired" | null; fingerprint?: string } | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--json") json = true;
    else if (arg === "--approve" || arg === "--retire" || arg === "--reopen") {
      const target = args[++i];
      if (decision !== undefined || target === undefined) return usage();
      const [id, fingerprint, extra] = arg === "--approve" ? target.split("@") : [target];
      if (id === undefined || !validProjectLessonId(id) || extra !== undefined ||
          (fingerprint !== undefined && !/^[a-f0-9]{12}$/.test(fingerprint))) return usage();
      decision = { id, state: actions[arg], ...(fingerprint === undefined ? {} : { fingerprint }) };
    } else if (arg.startsWith("-")) return usage();
    else positional.push(arg);
  }
  if (positional.length > 1) return usage();

  const folder = resolve(positional[0] ?? ".");
  const records = stateDirProjectRecords(io.stateDir());
  const found = records.read(folder);
  if (!found.ok) {
    if (decision !== undefined) return refuse(found.problem.message);
    stderr(`project lessons: warning: ${found.problem.message}\n`);
  }
  const record = found.ok ? found.record : null;
  const { lessons, problems } = readProjectLessons(folder);
  const calls = { ...record?.lessonCalls };
  if (decision !== undefined) {
    if (record === null) return refuse("Open the project in a regular chat before deciding a lesson.");
    const live = io.liveTurn(folder, record.id);
    if (live !== null) return refuse(`A turn is running on ${live}, a chat on this project. Wait for it to finish, then decide.`);
    const { id, state } = decision;
    const lesson = lessons.find((item) => item.id === id);
    if (lesson === undefined && (state !== null || !Object.hasOwn(calls, id))) {
      return refuse(`No valid lesson named ${id}.`);
    }
    if (state === "approved" && lesson !== undefined) {
      if (lesson.declaredStatus !== "active") return refuse(`Cannot approve ${id} with status: ${lesson.declaredStatus}. Set status: active first.`);
      const fingerprint = lesson.hash.slice(0, 12);
      if (decision.fingerprint === undefined) return refuse(`Current fingerprint: ${fingerprint}. Review the lesson and use --approve ${id}@${fingerprint}.`);
      if (decision.fingerprint !== fingerprint) return refuse("The lesson has changed. Read it again before approving.");
    }
    const call = state === null ? null : { state, hash: lesson!.hash };
    if (call !== null || Object.hasOwn(calls, id)) {
      const written = records.write(folder, record.id, record.seq, record.state, undefined, { id, call });
      if (!written.ok) return refuse(written.problem.message);
      if (call === null) delete calls[id];
      else calls[id] = call;
      if (!json) stdout(`${id} is ${state ?? "reopened"} now.\n`);
    }
  }

  const rows = lessons.map((lesson) => {
    const { id, title, declaredStatus, always, touches } = lesson;
    return { id, title, fingerprint: lesson.hash.slice(0, 12), declaredStatus, always, touches, ...projectLessonStatus(lesson, Object.hasOwn(calls, id) ? calls[id] : undefined) };
  });
  const staleChoices = Object.entries(calls).flatMap(([id, { state }]) => {
    const row = rows.find((row) => row.id === id);
    return row !== undefined && !row.stale ? [] : [{ id, state, reason: row === undefined ? "missing-or-invalid" : "changed" }];
  });
  if (json) {
    stdout(JSON.stringify({ lessons: rows, problems, ...(staleChoices.length === 0 ? {} : { staleChoices }) }, null, 2) + "\n");
  } else {
    const lines = rows.map(({ id, title, declaredStatus, effectiveStatus, personState, always, touches, fingerprint }) =>
      `${id}@${fingerprint}  ${title} (${effectiveStatus}, declared: ${declaredStatus}, person: ${personState ?? "no current choice"}, always: ${always}, touches: ${JSON.stringify(touches)})`,
    );
    lines.push(...staleChoices.map(({ id, state, reason }) => `Stale choice for ${id} (${state}): ${reason}.`));
    lines.push(...problems.map(({ file, reason }) => "Skipped " + JSON.stringify(file) + ": " + reason));
    stdout(lines.length === 0 ? "No project lessons found.\n" : lines.join("\n") + "\n");
  }
  return problems.some(({ file }) => file === "lessons") ? 1 : 0;
}
