/**
 * Issue #109: a session references its fusion project in the folder
 * store; a session saved before the store migrates there on first open.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { stateDirProjectRecords } from "./project-decisions.js";
import { createProject, projectFilePath } from "./project-store.js";
import { createSessionProjectStore, sameProjectFolder, type SessionProjectStore } from "./session-project-store.js";
import { applyProjectDecision, gateVersion, normalizeProject, type ProjectState } from "./session-project.js";
import { createEmptySessionState, type SessionState } from "./session-state.js";
import { SessionStore } from "./session-store.js";
import { normalizeSessionState } from "./normalize-session-state.js";

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "session-with-embedded-project-109.json"), "utf8")) as {
  session: Record<string, unknown>;
};

let folder: string;
let stateDir: string;
let projects: SessionProjectStore;
let store: SessionStore;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "aa-folder-"));
  stateDir = mkdtempSync(join(tmpdir(), "aa-state-"));
  projects = createSessionProjectStore({ stateDir, records: stateDirProjectRecords(stateDir) });
  store = new SessionStore({ dbFile: join(stateDir, "sessions.sqlite"), projectStore: projects });
});

afterEach(() => {
  store.close();
  rmSync(folder, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

/** The fixture session, as a store before issue #109 saved it, in this test's folder. */
function savePreStoreSession(id = "s-109-fixture"): ProjectState {
  const state = normalizeSessionState({ ...fixture.session, id, workingDir: folder }) as SessionState;
  // The run's picture lies in this machine's state dir, as a real run leaves it.
  state.project = {
    ...state.project!,
    milestones: state.project!.milestones.map((m) =>
      m.attachments === undefined ? m : { ...m, attachments: m.attachments.map((a) => ({ ...a, path: join(stateDir, "fusion-runs", "run-1", "shots", "t1-1.png") })) }),
  };
  // Written without a project store: exactly the row an older build left.
  const old = new SessionStore({ dbFile: join(stateDir, "sessions.sqlite") });
  old.save(state);
  old.close();
  return state.project!;
}

function rowPayload(id: string): Record<string, unknown> {
  const raw = new SessionStore({ dbFile: join(stateDir, "sessions.sqlite") });
  try {
    // A store without the project store reads the row as written.
    return raw.load(id) as unknown as Record<string, unknown>;
  } finally {
    raw.close();
  }
}

describe("session project reference (issue #109)", () => {
  it("migrates an embedded project on first open without losing evidence, verdicts or approvals", () => {
    const embedded = savePreStoreSession();
    expect(rowPayload("s-109-fixture").project).toBeDefined();

    const opened = store.load("s-109-fixture")!;
    expect(opened.project).toEqual(embedded);
    expect(opened.projectRef?.folder).toBe(folder);
    const m = opened.project!.milestones;
    expect(m[0]?.state).toBe("reviewed");
    expect(m[0]?.reviewOverride?.note).toBe("reviewer offline; checked by hand");
    expect(m[0]?.criteriaFacts?.[0]?.reservation).toBe("only a lint-warned check supports it");
    expect(m[1]?.corrections?.[0]?.note).toBe("Need ten levels, not five");
    expect(opened.project!.gate).toEqual({ kind: "milestone", id: "m2" });
    expect(opened.project!.plan?.status).toBe("approved");
    expect(opened.project!.brief?.status).toBe("approved");

    // The embedded copy stays in the row until a save after the store write.
    expect(rowPayload("s-109-fixture").project).toBeDefined();
    store.save(opened);
    const after = rowPayload("s-109-fixture");
    expect(after.project).toBeUndefined();
    expect(after.projectRef).toMatchObject({ folder, id: opened.projectRef!.id });

    // project.json holds content only.
    expect(readFileSync(projectFilePath(folder), "utf8")).not.toContain("reviewOverride");
    expect(store.load("s-109-fixture")!.project).toEqual(embedded);
  });

  it("the project survives deleting its chat: a new chat in the folder finds it", () => {
    const embedded = savePreStoreSession();
    store.save(store.load("s-109-fixture")!);
    store.delete("s-109-fixture");
    const fresh = createEmptySessionState({ id: "s-new", workingDir: folder });
    // Only a chat that runs the project flow is bound.
    expect(projects.prepareTurn(fresh, false).project).toBeUndefined();
    const bound = projects.prepareTurn(fresh, true);
    expect(bound.project).toEqual(embedded);
    expect(bound.projectRef?.folder).toBe(folder);
  });

  it("keeps the project embedded when the folder already holds another one", () => {
    const other = createProject(folder, { milestones: [], gate: { kind: "none" } }, { stateDir, records: stateDirProjectRecords(stateDir) });
    expect(other.ok).toBe(true);
    const embedded = savePreStoreSession();
    const opened = store.load("s-109-fixture")!;
    expect(opened.projectRef).toBeUndefined();
    expect(opened.project).toEqual(embedded);
    store.save(opened);
    expect(rowPayload("s-109-fixture").project).toBeDefined();
  });

  it("does not open a reference to another folder (its constraints would not apply)", () => {
    savePreStoreSession();
    const opened = store.load("s-109-fixture")!;
    const elsewhere = mkdtempSync(join(tmpdir(), "aa-elsewhere-"));
    try {
      const moved = projects.load({ ...opened, workingDir: elsewhere });
      expect(moved.project).toBeUndefined();
      expect(moved.projectProblem).toMatch(/not in the chat's folder/);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("a damaged file is reported, the project does not open, and nothing is decided or written", () => {
    savePreStoreSession();
    const opened = store.load("s-109-fixture")!;
    store.save(opened);
    writeFileSync(projectFilePath(folder), "{ broken");
    const broken = store.load("s-109-fixture")!;
    expect(broken.project).toBeUndefined();
    expect(broken.projectProblem).toMatch(/not valid JSON/);
    const written = projects.commit(broken, opened.project!);
    expect(!written.ok && written.problem.code).toBe("damaged");
    expect(readFileSync(projectFilePath(folder), "utf8")).toBe("{ broken");
  });

  it("two chats on one project: the second approval of the same gate is \"gate already decided\"", () => {
    savePreStoreSession("chat-a");
    const a = store.load("chat-a")!;
    store.save(a);
    const b = projects.prepareTurn(createEmptySessionState({ id: "chat-b", workingDir: folder }), true);
    const decision = { gate: a.project!.gate, version: gateVersion(a.project)!, verdict: "approve" as const };
    const decide = (s: SessionState) => {
      const r = applyProjectDecision(s.project, decision, { now: 5 });
      if (!r.ok) throw new Error(r.error.message);
      return projects.commit(s, r.project, { input: decision, decidedOn: s.project! });
    };
    const first = decide(a);
    expect(first.ok && first.session.project?.milestones[1]?.state).toBe("reviewed");
    const second = decide(b);
    expect(!second.ok && second.problem.code).toBe("already-decided");
    // B, reloaded, sees A's decision and the gate as decided.
    expect(projects.load(b).project?.milestones[1]?.state).toBe("reviewed");
    expect(projects.decided(b, decision.gate, decision.version)).toBe(true);
  });

  it("a project copied to another machine opens with its content; its gates wait again", () => {
    savePreStoreSession();
    store.save(store.load("s-109-fixture")!);
    const otherState = mkdtempSync(join(tmpdir(), "aa-other-state-"));
    try {
      const there = createSessionProjectStore({ stateDir: otherState, records: stateDirProjectRecords(otherState) });
      const p = there.prepareTurn(createEmptySessionState({ id: "x", workingDir: folder }), true).project!;
      expect(p.gate).toEqual({ kind: "brief" });
      // Execution state stays on the machine that ran it: content travels, runs and evidence start over.
      expect(p.brief?.what).toBe("A puzzle game");
      expect(p.plan?.rows).toHaveLength(3);
      expect(p.milestones.map((m) => `${m.state}:${m.criteriaFacts?.length ?? 0}`)).toEqual(["planned:0", "planned:0", "planned:0"]);
      expect(p.changedOutside).toEqual(["brief", "plan"]);
    } finally {
      rmSync(otherState, { recursive: true, force: true });
    }
  });

  it("compares folders case-insensitively on Windows", () => {
    expect(sameProjectFolder("C:\\Work\\Game", "c:\\work\\game\\", "win32")).toBe(true);
    expect(sameProjectFolder("/work/Game", "/work/game", "linux")).toBe(false);
  });

  it("an old session without a store keeps reading as before", () => {
    const embedded = savePreStoreSession();
    expect(normalizeProject(rowPayload("s-109-fixture").project)).toEqual(embedded);
  });
});

describe("records are bound to the project folder (issue #109 review)", () => {
  it("a copied folder borrows none of the original's approvals, and its writes never touch the original's record (review a3)", async () => {
    const { cpSync, readdirSync } = await import("node:fs");
    const embedded = savePreStoreSession();
    const a = store.load("s-109-fixture")!;
    store.save(a);
    const copy = `${folder}-copy`;
    cpSync(folder, copy, { recursive: true });
    try {
      const records = () => readdirSync(join(stateDir, "project-decisions")).filter((f) => f.endsWith(".json")).sort();
      const before = records().map((f) => readFileSync(join(stateDir, "project-decisions", f), "utf8"));
      const b = projects.prepareTurn(createEmptySessionState({ id: "b", workingDir: copy }), true);
      expect(b.project?.gate).toEqual({ kind: "brief" });
      expect(b.project?.plan?.status).toBe("draft");
      expect(b.project?.changedOutside).toEqual(["brief", "plan"]);
      const changed = { ...b.project!, brief: { ...b.project!.brief!, how: "Changed in the copy" } };
      const w = projects.commit(b, changed);
      expect(w.ok).toBe(true);
      // The copy got its own id; the original's record is untouched.
      if (w.ok) expect(w.session.projectRef?.id).not.toBe(a.projectRef?.id);
      expect(records()).toHaveLength(2);
      const original = projects.load(a);
      expect(original.project).toEqual(embedded);
      expect(before.every((text) => records().some((f) => readFileSync(join(stateDir, "project-decisions", f), "utf8") === text))).toBe(true);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });

  it("another project's project.json copied into a folder brings none of its approvals", () => {
    savePreStoreSession();
    store.save(store.load("s-109-fixture")!);
    const other = mkdtempSync(join(tmpdir(), "aa-other-"));
    try {
      const { mkdirSync, copyFileSync } = require("node:fs") as typeof import("node:fs");
      mkdirSync(join(other, ".atomic", "project"), { recursive: true });
      copyFileSync(projectFilePath(folder), projectFilePath(other));
      const p = projects.prepareTurn(createEmptySessionState({ id: "o", workingDir: other }), true).project!;
      expect(p.brief?.status).toBe("draft");
      expect(p.milestones.every((m) => m.state === "planned")).toBe(true);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("ids that differ only by case have separate records", async () => {
    const { stateDirProjectRecords: records } = await import("./project-decisions.js");
    const r = records(stateDir);
    const p = normalizeProject(fixture.session.project)!;
    expect(r.write(folder, "Proj", 0, p).ok).toBe(true);
    expect(r.write(folder, "proj", 0, { ...p, gate: { kind: "none" } }).ok).toBe(true);
    const a = r.read(folder, "Proj");
    const b = r.read(folder, "proj");
    expect(a.ok && a.record?.state.gate).toEqual({ kind: "milestone", id: "m2" });
    expect(b.ok && b.record?.state.gate).toEqual({ kind: "none" });
  });
});

describe("an incognito chat leaves nothing behind (issue #109 review, ATO-586)", () => {
  it("keeps its project in the session and never writes the folder store, the registry or a record", async () => {
    const { existsSync } = await import("node:fs");
    const { projectRegistryPath } = await import("./project-registry.js");
    const incognito = { since: 1, owner: "pid:1" };
    const p = normalizeProject(fixture.session.project)!;
    const chat: SessionState = { ...createEmptySessionState({ id: "inc", workingDir: folder }), incognito, project: p };
    expect(projects.load(chat)).toBe(chat);
    const committed = projects.commit(chat, { ...p, gate: { kind: "none" } });
    expect(committed.ok && committed.session.project?.gate).toEqual({ kind: "none" });
    expect(committed.ok && committed.session.projectRef).toBeUndefined();
    const fresh: SessionState = { ...createEmptySessionState({ id: "inc2", workingDir: folder }), incognito };
    const brief = projects.commit(fresh, p);
    expect(brief.ok && brief.session.projectRef).toBeUndefined();
    expect(existsSync(projectFilePath(folder))).toBe(false);
    expect(existsSync(projectRegistryPath(stateDir))).toBe(false);
    expect(existsSync(join(stateDir, "project-decisions"))).toBe(false);
    // A folder that holds a project does not bind an incognito chat either.
    const other = createSessionProjectStore({ stateDir, records: stateDirProjectRecords(stateDir) });
    other.commit(createEmptySessionState({ id: "plain", workingDir: folder }), p);
    expect(projects.prepareTurn(fresh, true).project).toBeUndefined();
  });
});

describe("an unusable record is reported and never overwritten (issue #109 review a5)", () => {
  const recordFile = (): string => {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const dir = join(stateDir, "project-decisions");
    return join(dir, readdirSync(dir).find((f) => f.endsWith(".json"))!);
  };
  const setUp = (): SessionState => {
    savePreStoreSession();
    const s = store.load("s-109-fixture")!;
    store.save(s);
    return s;
  };

  it.each([
    ["a newer version", (j: any) => ({ ...j, version: 2 }), /record/],
    ["a decision without a gate", (j: any) => ({ ...j, decisions: [{}] }), /record/],
    ["an empty state", (j: any) => ({ ...j, state: {} }), /record/],
    ["not an object", () => [], /record/],
  ])("%s: the chat opens without the project, nothing is approved or written", (_what, change, message) => {
    const s = setUp();
    const file = recordFile();
    const body = JSON.stringify(change(JSON.parse(readFileSync(file, "utf8"))));
    writeFileSync(file, body);
    const opened = store.load("s-109-fixture")!;
    expect(opened.project).toBeUndefined();
    expect(opened.projectProblem).toMatch(message);
    const written = projects.commit(opened, s.project!);
    expect(written.ok).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(body);
  });

  it("a record that cannot be read right now is not replaced", () => {
    const s = setUp();
    const file = recordFile();
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    rmSync(file);
    mkdirSync(file);
    const opened = projects.load(s);
    expect(opened.project).toBeUndefined();
    expect(projects.commit(opened, s.project!).ok).toBe(false);
  });
});
