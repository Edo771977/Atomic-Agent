/**
 * Issue #109: `atomic-agent projects list` and `project resume <folder>`.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { stateDirProjectRecords } from "../session/project-decisions.js";
import { projectRegistryPath, readProjectRegistry } from "../session/project-registry.js";
import { projectFilePath } from "../session/project-store.js";
import { createSessionProjectStore, type SessionProjectStore } from "../session/session-project-store.js";
import { normalizeProject, type ProjectState } from "../session/session-project.js";
import { createEmptySessionState } from "../session/session-state.js";
import { SessionStore } from "../session/session-store.js";
import { listProjectRows, projectCommand, projectsCommand } from "./projects-command.js";

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "..", "session", "fixtures", "session-with-embedded-project-109.json"), "utf8")) as {
  session: { project: unknown };
};

let root: string;
let stateDir: string;
let projects: SessionProjectStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aa-projects-"));
  stateDir = join(root, "state");
  mkdirSync(stateDir);
  projects = createSessionProjectStore({ stateDir, records: stateDirProjectRecords(stateDir) });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A folder with the fixture project, opened once by a chat (which registers it). */
function folderWithProject(name: string): string {
  const folder = join(root, name);
  mkdirSync(folder);
  const project = normalizeProject(fixture.session.project) as ProjectState;
  const r = projects.commit(createEmptySessionState({ id: `chat-${name}`, workingDir: folder }), project);
  if (!r.ok) throw new Error(r.problem.message);
  return folder;
}

function io() {
  let out = "";
  let err = "";
  return { stateDir: () => stateDir, stdout: (t: string) => { out += t; }, stderr: (t: string) => { err += t; }, out: () => out, err: () => err };
}

describe("projects list (issue #109)", () => {
  it("lists name, folder, gate, next action, last change and spend; missing and damaged folders are rows", async () => {
    const game = folderWithProject("game");
    const gone = folderWithProject("gone");
    const broken = folderWithProject("broken");
    rmSync(gone, { recursive: true, force: true });
    writeFileSync(projectFilePath(broken), "{");
    // The registry holds paths only.
    expect(JSON.parse(readFileSync(projectRegistryPath(stateDir), "utf8"))).toEqual({ version: 1, folders: [game, gone, broken] });

    const { rows } = listProjectRows(stateDir);
    expect(rows[0]).toMatchObject({ folder: game, status: "ok", zone: "needs-you", name: "game", gate: "milestone m2", next: "you review milestone m2", spentUsd: null });
    expect(typeof rows[0]!.updatedAt).toBe("number");
    expect(rows[1]).toMatchObject({ folder: gone, status: "missing", zone: "problem" });
    expect(rows[2]).toMatchObject({ folder: broken, status: "damaged", zone: "problem" });

    const t = io();
    expect(await projectsCommand(["list"], t)).toBe(0);
    expect(t.out()).toContain(`game  (${game})`);
    expect(t.out()).toContain("waiting on: milestone m2");
    expect(t.out()).toContain("attention: needs-you");
    expect(t.out()).toContain("next: you review milestone m2");
    expect(t.out()).toContain("last change: ");
    expect(t.out()).toContain("missing: ");
    expect(t.out()).toContain("damaged: ");
    expect(t.out().match(/attention: problem/g)).toHaveLength(2);
    const j = io();
    expect(await projectsCommand(["list", "--json"], j)).toBe(0);
    expect(JSON.parse(j.out())).toMatchObject([
      { folder: game, zone: "needs-you" },
      { folder: gone, zone: "problem" },
      { folder: broken, zone: "problem" },
    ]);
  });

  it("reports a damaged registry without overwriting it, and forgets a folder", async () => {
    const game = folderWithProject("game");
    const f = io();
    expect(await projectsCommand(["forget", game], f)).toBe(0);
    expect(readProjectRegistry(stateDir)).toEqual({ ok: true, folders: [] });
    writeFileSync(projectRegistryPath(stateDir), "nope");
    const t = io();
    expect(await projectsCommand(["list"], t)).toBe(1);
    expect(t.err()).toMatch(/not valid JSON/);
    expect(readFileSync(projectRegistryPath(stateDir), "utf8")).toBe("nope");
    expect(await projectsCommand(["list", "--bogus"], io())).toBe(2);
  });
});

describe("project resume (issue #109)", () => {
  it("opens a chat on the folder's project and shows the gate waiting for the person", async () => {
    const game = folderWithProject("game");
    const store = new SessionStore({ dbFile: join(stateDir, "sessions.sqlite"), projectStore: projects });
    try {
      const t = io();
      const opened: string[] = [];
      const code = await projectCommand(["resume", game], {
        ...t,
        sessionStore: store,
        projectStore: projects,
        newSessionId: () => "s-resumed",
        openChat: async (id) => { opened.push(id); return 0; },
      });
      expect(code).toBe(0);
      expect(t.out()).toContain('Milestone "Levels" is done and waits for your review');
      expect(t.out()).toContain("atomic-agent run --session s-resumed --approve");
      expect(t.out()).toContain("chat: s-resumed (new)");
      expect(opened).toEqual(["s-resumed"]);
      const saved = store.load("s-resumed")!;
      expect(saved.projectRef?.folder).toBe(game);
      expect(saved.project?.gate).toEqual({ kind: "milestone", id: "m2" });

      // Again: the same chat, not a new one; --no-open prints only.
      const again = io();
      expect(await projectCommand(["resume", game, "--no-open"], { ...again, sessionStore: store, projectStore: projects, openChat: async () => 9 })).toBe(0);
      expect(again.out()).toContain("chat: s-resumed\n");
    } finally {
      store.close();
    }
  });

  it("reports a folder with no project or a damaged one, and opens nothing", async () => {
    const empty = join(root, "empty");
    mkdirSync(empty);
    const t = io();
    expect(await projectCommand(["resume", empty], { ...t, projectStore: projects, sessionStore: undefined as never })).toBe(1);
    expect(t.err()).toMatch(/No project in/);
    const broken = folderWithProject("broken");
    writeFileSync(projectFilePath(broken), JSON.stringify({ schemaVersion: 7 }));
    const b = io();
    expect(await projectCommand(["resume", broken], { ...b, projectStore: projects })).toBe(1);
    expect(b.err()).toMatch(/schema version 7/);
    expect(await projectCommand(["resume"], io())).toBe(2);
  });
});

describe("project backlog (issue #111)", () => {
  /** The fixture folder with two items added by a chat's director. */
  function folderWithBacklog(): string {
    const folder = join(root, "game");
    mkdirSync(folder);
    let project = normalizeProject(fixture.session.project) as ProjectState;
    project = { ...project, backlog: [
      { id: "b1", title: "Export PDF", condition: "when the report exists", source: "director", createdAt: 1 },
      { id: "b2", title: "Dark mode", source: "person", createdAt: 2, origin: { milestoneId: "m2" } },
    ] };
    const r = projects.commit(createEmptySessionState({ id: "chat-game", workingDir: folder }), project);
    if (!r.ok) throw new Error(r.problem.message);
    return folder;
  }

  it("lists the items with their state, source and seed condition", async () => {
    const folder = folderWithBacklog();
    const t = io();
    expect(await projectCommand(["backlog", folder], t)).toBe(0);
    expect(t.out()).toContain("b1 open  Export PDF  (seed: when the report exists; from director)");
    expect(t.out()).toContain("b2 open  Dark mode  (from person, milestone m2)");
    expect(t.out()).toContain("2 open");
    const j = io();
    expect(await projectCommand(["backlog", folder, "--json"], j)).toBe(0);
    expect(JSON.parse(j.out()).items.map((b: { id: string; state: string }) => `${b.id}:${b.state}`)).toEqual(["b1:open", "b2:open"]);
  });

  it("--promote and --drop are the person's calls, kept in the record and never in project.json", async () => {
    const folder = folderWithBacklog();
    const before = readFileSync(projectFilePath(folder), "utf8");
    expect(await projectCommand(["backlog", folder, "--promote", "b1"], io())).toBe(0);
    expect(await projectCommand(["backlog", folder, "--drop", "b2"], io())).toBe(0);
    const t = io();
    expect(await projectCommand(["backlog", folder], t)).toBe(0);
    expect(t.out()).toContain("b1 promoted");
    expect(t.out()).toContain("b2 dropped");
    const raw = readFileSync(projectFilePath(folder), "utf8");
    expect(raw).not.toMatch(/promoted|dropped/);
    expect(JSON.parse(raw).project.backlog).toEqual(JSON.parse(before).project.backlog);
    const record = stateDirProjectRecords(stateDir).read(folder);
    expect(record.ok && record.record?.state.backlogStates).toEqual({ b1: "promoted", b2: "dropped" });
    // The gate the project waited at did not move.
    expect(record.ok && record.record?.state.gate).toEqual({ kind: "milestone", id: "m2" });
    expect(await projectCommand(["backlog", folder, "--reopen", "b2"], io())).toBe(0);
    const again = stateDirProjectRecords(stateDir).read(folder);
    expect(again.ok && again.record?.state.backlogStates).toEqual({ b1: "promoted" });
  });

  it("says whether a promoted item is in a plan yet (review)", async () => {
    const folder = folderWithBacklog();
    expect(await projectCommand(["backlog", folder, "--promote", "b1"], io())).toBe(0);
    const t = io();
    expect(await projectCommand(["backlog", folder], t)).toBe(0);
    expect(t.out()).toContain("b1 promoted, not in any plan  Export PDF");
    // The person approves a plan after the promotion: it records which version took it in.
    const record = stateDirProjectRecords(stateDir).read(folder);
    if (!record.ok || record.record === null) throw new Error("no record");
    const state = record.record.state;
    const calls = { b1: { ...state.backlogCalls!.b1!, plannedIn: 4 } };
    const w = stateDirProjectRecords(stateDir).write(folder, record.record.id, record.record.seq, { ...state, backlogCalls: calls });
    expect(w.ok).toBe(true);
    const u = io();
    expect(await projectCommand(["backlog", folder], u)).toBe(0);
    expect(u.out()).toContain("b1 promoted, taken in by plan v4  Export PDF");
    const j = io();
    expect(await projectCommand(["backlog", folder, "--json"], j)).toBe(0);
    expect(JSON.parse(j.out()).items[0]).toMatchObject({ id: "b1", state: "promoted", plannedIn: 4 });
  });

  it("says when the person deferred a promoted item at the plan gate (issue #146)", async () => {
    const folder = folderWithBacklog();
    expect(await projectCommand(["backlog", folder, "--promote", "b1"], io())).toBe(0);
    const record = stateDirProjectRecords(stateDir).read(folder);
    if (!record.ok || record.record === null) throw new Error("no record");
    const state = record.record.state;
    const w = stateDirProjectRecords(stateDir).write(folder, record.record.id, record.record.seq, { ...state, backlogCalls: { b1: { ...state.backlogCalls!.b1!, deferred: true } } });
    expect(w.ok).toBe(true);
    const t = io();
    expect(await projectCommand(["backlog", folder], t)).toBe(0);
    expect(t.out()).toContain("b1 promoted, deferred at the plan gate, not in any plan  Export PDF");
    const j = io();
    expect(await projectCommand(["backlog", folder, "--json"], j)).toBe(0);
    expect(JSON.parse(j.out()).items[0]).toMatchObject({ id: "b1", state: "promoted", deferred: true });
  });

  it("refuses a call while a turn runs on a chat bound to the project (review)", async () => {
    const folder = folderWithBacklog();
    const store = new SessionStore({ dbFile: join(stateDir, "sessions.sqlite"), projectStore: projects });
    try {
      const chat = projects.prepareTurn(createEmptySessionState({ id: "chat-live", workingDir: folder }), true);
      store.save(chat);
      expect(store.beginTurn("chat-live")).toBe(true);
      const t = io();
      expect(await projectCommand(["backlog", folder, "--promote", "b1"], { ...t, sessionStore: store })).toBe(1);
      expect(t.err()).toMatch(/a turn is running on chat-live/);
      const record = stateDirProjectRecords(stateDir).read(folder);
      expect(record.ok && record.record?.state.backlogStates).toBeUndefined();
      // Listing is fine mid-turn; once the turn ends the call goes through.
      expect(await projectCommand(["backlog", folder], { ...io(), sessionStore: store })).toBe(0);
      store.releaseTurn("chat-live", { status: "completed" });
      expect(await projectCommand(["backlog", folder, "--promote", "b1"], { ...io(), sessionStore: store })).toBe(0);
    } finally {
      store.close();
    }
  });

  it("refuses a call on a folder this computer has no record for (review)", async () => {
    const folder = folderWithBacklog();
    const before = readFileSync(projectFilePath(folder), "utf8");
    const elsewhere = join(root, "other-state");
    mkdirSync(elsewhere);
    const t = { ...io(), stateDir: () => elsewhere };
    expect(await projectCommand(["backlog", folder, "--promote", "b1"], t)).toBe(1);
    expect(t.err()).toMatch(/open this project in a chat first/);
    expect(readFileSync(projectFilePath(folder), "utf8")).toBe(before);
    // Listing is fine without a record.
    expect(await projectCommand(["backlog", folder], { ...io(), stateDir: () => elsewhere })).toBe(0);
  });

  it("refuses an unknown item, two calls at once and a folder without a project", async () => {
    const folder = folderWithBacklog();
    const u = io();
    expect(await projectCommand(["backlog", folder, "--drop", "b9"], u)).toBe(1);
    expect(u.err()).toMatch(/no item b9/);
    expect(await projectCommand(["backlog", folder, "--drop", "b1", "--promote", "b2"], io())).toBe(2);
    expect(await projectCommand(["backlog", folder, "--drop"], io())).toBe(2);
    const empty = join(root, "empty");
    mkdirSync(empty);
    expect(await projectCommand(["backlog", empty], io())).toBe(1);
  });
});

it("saves and revokes UI exceptions in the record without rewriting the project file", async () => {
  const folder = folderWithProject("ui");
  const before = readFileSync(projectFilePath(folder), "utf8");
  const store = new SessionStore({ dbFile: join(stateDir, "sessions.db") });
  try {
    const deps = { ...io(), sessionStore: store };
    const allow = ["ui-exceptions", folder, "--allow", "low-contrast:index.html", "--reason", "Brand logo"];
    const chat = projects.prepareTurn(createEmptySessionState({ id: "busy", workingDir: folder }), true);
    store.save(chat);
    expect(store.beginTurn(chat.id)).toBe(true);
    expect(await projectCommand(allow, deps)).toBe(1);
    store.releaseTurn(chat.id, { status: "completed" });
    expect(await projectCommand(allow, deps)).toBe(0);
    expect(stateDirProjectRecords(stateDir).read(folder)).toMatchObject({
      record: { uiExceptions: [{ rule: "low-contrast", file: "index.html", reason: "Brand logo" }] },
    });
    expect(await projectCommand(["ui-exceptions", folder, "--revoke", "low-contrast:index.html"], deps)).toBe(0);
    expect(readFileSync(projectFilePath(folder), "utf8")).toBe(before);
    const privateFolder = join(root, "private");
    mkdirSync(privateFolder);
    expect(projects.commit(createEmptySessionState({ id: "private", workingDir: privateFolder,
      incognito: { since: Date.now(), owner: "test" } }), { gate: { kind: "none" }, milestones: [] }).ok).toBe(true);
    expect(await projectCommand(["ui-exceptions", privateFolder, ...allow.slice(2)], deps)).toBe(1);
  } finally {
    store.close();
  }
});
