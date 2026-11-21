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
    const j = io();
    expect(await projectsCommand(["list", "--json"], j)).toBe(0);
    expect(JSON.parse(j.out())).toHaveLength(3);
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
