import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as bootstrap from "../runtime/bootstrap.js";
import * as configuration from "../config/index.js";
import { stateDirProjectRecords } from "../session/project-decisions.js";
import { fixtureProjectGateView } from "../session/project-gate-view-fixtures.js";
import { readProjectRegistry } from "../session/project-registry.js";
import { projectFilePath } from "../session/project-store.js";
import { createSessionProjectStore, type SessionProjectStore } from "../session/session-project-store.js";
import { normalizeProject, type ProjectState } from "../session/session-project.js";
import { createEmptySessionState } from "../session/session-state.js";
import { SessionStore } from "../session/session-store.js";
import { bootstrapSidecar } from "./main.js";

/**
 * Issue #109, part 2: the projects list over NDJSON — `list_projects`,
 * `forget_project`, `resume_project` and `get_project_problem` — on a
 * fixture state dir with a healthy project, a damaged one and a missing
 * folder. The runtime is stubbed around a real session store.
 */

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "..", "session", "fixtures", "session-with-embedded-project-109.json"), "utf8")) as {
  session: { project: unknown };
};

let root: string;
let stateDir: string;
let projects: SessionProjectStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aa-sidecar-projects-"));
  stateDir = join(root, "state");
  mkdirSync(stateDir);
  projects = createSessionProjectStore({ stateDir, records: stateDirProjectRecords(stateDir) });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function folderWithProject(name: string): string {
  const folder = join(root, name);
  mkdirSync(folder);
  const project = normalizeProject(fixture.session.project) as ProjectState;
  const r = projects.commit(createEmptySessionState({ id: `chat-${name}`, workingDir: folder }), project);
  if (!r.ok) throw new Error(r.problem.message);
  return folder;
}

async function sidecarOn(store: SessionStore) {
  const config = configuration.loadConfig();
  config.llm = { activeTextProvider: "cloud", activeEmbeddingProvider: "cloud", toolTransport: "auto", providers: [{ id: "cloud", kind: "openai-compatible", baseUrl: "https://paid.invalid" }] };
  config.paths = { ...config.paths, stateDir };
  vi.spyOn(configuration, "getConfig").mockReturnValue(config);
  const built: string[] = [];
  vi.spyOn(bootstrap, "createAgentRuntime").mockImplementation(async (options) => {
    built.push(options.workingDir);
    return {
      createSession: () => ({ id: "fresh" }),
      shutdown: async () => {},
      sessionStore: store,
      projectState: (id: string) => (store.load(id)?.project === undefined ? null : fixtureProjectGateView({ kind: "milestone", id: "m2" }, { sessionId: id })),
    } as unknown as bootstrap.AgentRuntime;
  });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const streams = [process.stdin, process.stdin, process.stdout, process.stdout];
  const names = ["data", "end", "error", "close"];
  const kept = names.map((name, i) => streams[i]!.listeners(name));
  const sidecar = await bootstrapSidecar();
  const emitted = vi.spyOn(sidecar.protocol, "emitEvent");
  const responses = new Map<string, { ok: boolean; payload: unknown }>();
  vi.spyOn(sidecar.protocol, "respond").mockImplementation((id, payload, ok = true) => {
    responses.set(id, { ok, payload });
    return { kind: "response", id: `response-${id}`, correlationId: id, ok, payload };
  });
  const send = (id: string, type: string, payload: unknown) =>
    process.stdin.emit("data", JSON.stringify({ kind: "request", id, type, payload }) + "\n");
  const response = async (id: string) => {
    await vi.waitFor(() => expect(responses.has(id)).toBe(true));
    return responses.get(id)!;
  };
  const close = async () => {
    for (let i = 0; i < names.length; i++) {
      for (const listener of streams[i]!.listeners(names[i]!)) {
        if (!kept[i]!.includes(listener)) streams[i]!.removeListener(names[i]!, listener as () => void);
      }
    }
    await sidecar.shutdown();
  };
  return { send, response, emitted, built, close };
}

it("lists the known projects with damaged and missing folders as rows, resumes one and forgets one", async () => {
  const game = folderWithProject("game");
  const gone = folderWithProject("gone");
  const broken = folderWithProject("broken");
  rmSync(gone, { recursive: true, force: true });
  writeFileSync(projectFilePath(broken), "{");
  const store = new SessionStore({ dbFile: join(stateDir, "sessions.sqlite"), projectStore: projects });
  const s = await sidecarOn(store);
  try {
    s.send("list", "list_projects", {});
    const list = (await s.response("list")).payload as { schema: number; projects: Array<Record<string, unknown>>; registryProblem: string | null };
    expect(list.schema).toBe(1);
    expect(list.registryProblem).toBeNull();
    expect(list.projects.map((r) => [r.folder, r.status])).toEqual([[game, "ok"], [gone, "missing"], [broken, "damaged"]]);
    expect(list.projects[0]).toMatchObject({ name: "game", gate: "milestone m2", next: "you review milestone m2", spentUsd: null });
    expect(typeof list.projects[2]!.problem).toBe("string");

    // Resume: a new chat on the folder's project becomes the active session.
    s.send("resume", "resume_project", { folder: game });
    const resumed = (await s.response("resume")).payload as Record<string, unknown>;
    expect(resumed).toMatchObject({ schema: 1, ok: true, folder: game, name: "game", created: true, view: { gate: { kind: "milestone", id: "m2" } } });
    const sid = resumed.sessionId as string;
    expect(store.load(sid)?.projectRef?.folder).toBe(game);
    expect(s.built).toEqual([game]);
    expect(s.emitted.mock.calls.filter(([name]) => name === "session_started")).toEqual([["session_started", { sessionId: sid, workingDir: game }]]);
    // Seam: the existing get_project answer keeps its shape on the resumed session.
    s.send("get", "get_project", { sessionId: sid });
    expect((await s.response("get")).payload).toEqual({ sessionId: sid, view: fixtureProjectGateView({ kind: "milestone", id: "m2" }, { sessionId: sid }) });
    s.send("problem", "get_project_problem", { sessionId: sid });
    expect((await s.response("problem")).payload).toEqual({ sessionId: sid, problem: null });

    // Again: the same chat.
    s.send("again", "resume_project", { folder: game });
    expect((await s.response("again")).payload).toMatchObject({ ok: true, sessionId: sid, created: false });

    // A damaged project is refused with why; an unlisted folder is not resumed.
    s.send("broken", "resume_project", { folder: broken });
    expect((await s.response("broken")).payload).toMatchObject({ schema: 1, ok: false, folder: broken, error: { code: "project-unavailable" } });
    s.send("other", "resume_project", { folder: join(root, "elsewhere") });
    expect((await s.response("other")).payload).toMatchObject({ ok: false, error: { code: "not-listed" } });
    s.send("relative", "resume_project", { folder: "game" });
    expect((await s.response("relative")).ok).toBe(false);

    // The chat's project breaks: its problem is said.
    writeFileSync(projectFilePath(game), "{");
    s.send("problem2", "get_project_problem", { sessionId: sid });
    expect(((await s.response("problem2")).payload as { problem: string | null }).problem).toMatch(/project/i);

    // Forget: off the list, the folder's files stay.
    s.send("forget", "forget_project", { folder: gone });
    expect((await s.response("forget")).payload).toEqual({ schema: 1, folder: gone, forgotten: true });
    s.send("forget2", "forget_project", { folder: gone });
    expect((await s.response("forget2")).payload).toEqual({ schema: 1, folder: gone, forgotten: false });
    expect(readProjectRegistry(stateDir)).toEqual({ ok: true, folders: [game, broken] });
    s.send("forget3", "forget_project", { folder: broken });
    await s.response("forget3");
    expect(readFileSync(projectFilePath(broken), "utf8")).toBe("{");
  } finally {
    await s.close();
    store.close();
  }
});

it("reports a damaged list without rewriting it", async () => {
  mkdirSync(join(stateDir, "projects"));
  writeFileSync(join(stateDir, "projects", "registry.json"), "nope");
  const store = new SessionStore({ dbFile: join(stateDir, "sessions.sqlite"), projectStore: projects });
  const s = await sidecarOn(store);
  try {
    s.send("list", "list_projects", {});
    const list = (await s.response("list")).payload as { projects: unknown[]; registryProblem: string | null };
    expect(list.projects).toEqual([]);
    expect(list.registryProblem).toMatch(/not valid JSON/);
    expect(readFileSync(join(stateDir, "projects", "registry.json"), "utf8")).toBe("nope");
  } finally {
    await s.close();
    store.close();
  }
});
