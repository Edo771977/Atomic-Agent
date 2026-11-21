/**
 * Schema v2 of the fusion project's folder store: version 1 files and
 * embedded (pre-store) sessions open, round-trip, and are written as
 * version 2 on their next write; a newer version is refused, never overwritten.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { stateDirProjectRecords } from "./project-decisions.js";
import {
  PROJECT_SCHEMA_VERSION,
  commitProject,
  createProject,
  migrateProjectFile,
  openProject,
  projectFilePath,
  type ProjectStoreOptions,
} from "./project-store.js";
import { createSessionProjectStore } from "./session-project-store.js";
import { normalizeProject, type ProjectState } from "./session-project.js";
import { normalizeSessionState } from "./normalize-session-state.js";
import type { SessionState } from "./session-state.js";
import { SessionStore } from "./session-store.js";

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "session-with-embedded-project-109.json"), "utf8")) as {
  session: Record<string, unknown> & { project: unknown };
};

let folder: string;
let stateDir: string;
let options: ProjectStoreOptions;

function project(): ProjectState {
  const p = normalizeProject(fixture.session.project)!;
  return {
    ...p,
    milestones: p.milestones.map((m) => ({
      ...m,
      ...(m.attachments === undefined ? {} : { attachments: m.attachments.map((a) => ({ ...a, path: join(stateDir, "fusion-runs", "run-1", "shots", "t1-1.png") })) }),
    })),
  };
}

const readJson = () => JSON.parse(readFileSync(projectFilePath(folder), "utf8")) as Record<string, any>;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "aa-schema-"));
  stateDir = mkdtempSync(join(tmpdir(), "aa-state-"));
  options = { stateDir, records: stateDirProjectRecords(stateDir, () => 9), now: () => 1_700_000_100_000 };
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

describe("project.json schema version 2", () => {
  it("is the version this build writes", () => {
    expect(PROJECT_SCHEMA_VERSION).toBe(2);
    const r = createProject(folder, project(), { ...options, id: "proj-1" });
    expect(r.ok).toBe(true);
    expect(readJson().schemaVersion).toBe(2);
  });

  it("opens a version 1 file unchanged and writes it as version 2 on the next write, losing nothing", () => {
    const c = createProject(folder, project(), { ...options, id: "proj-1" });
    if (!c.ok) throw new Error(c.problem.message);
    // The same file as a version 1 build wrote it, with a later top-level field.
    const v1 = { ...readJson(), schemaVersion: 1, laterFeature: { a: 1 } };
    writeFileSync(projectFilePath(folder), `${JSON.stringify(v1, null, 2)}\n`);
    const opened = openProject(folder, options);
    if (!opened.ok) throw new Error(opened.problem.message);
    expect(opened.opened.project).toEqual(c.opened.project);
    // Opening writes nothing.
    expect(readJson().schemaVersion).toBe(1);

    const edited: ProjectState = { ...opened.opened.project, brief: { ...opened.opened.project.brief!, how: "Web canvas, no server" } };
    const w = commitProject(folder, "proj-1", { revision: opened.opened.stored.revision, decisionSeq: opened.opened.decisionSeq }, edited, options);
    if (!w.ok) throw new Error(w.problem.message);
    const after = readJson();
    expect(after.schemaVersion).toBe(2);
    expect(after.laterFeature).toEqual({ a: 1 });
    const { schemaVersion: _a, revision: _r, updatedAt: _u, project: p1, ...rest1 } = v1;
    const { schemaVersion: _b, revision: _s, updatedAt: _v, project: p2, ...rest2 } = after;
    expect(rest2).toEqual(rest1);
    expect({ ...p2, brief: { ...p2.brief, how: v1.project.brief.how } }).toEqual(p1);
  });

  it("has one migration path: version 1 to 2 changes the version only", () => {
    const raw = { schemaVersion: 1, id: "p", name: "x", revision: 1, createdAt: 1, updatedAt: 1, project: { milestones: [], gate: { kind: "none" } } };
    expect(migrateProjectFile(raw)).toEqual({ ...raw, schemaVersion: 2 });
    expect(migrateProjectFile({ ...raw, schemaVersion: 2 })).toEqual({ ...raw, schemaVersion: 2 });
    expect(migrateProjectFile({ ...raw, schemaVersion: 3 })).toBeNull();
  });

  it("rejects a version 3 file with a clear message and never overwrites it", () => {
    const c = createProject(folder, project(), { ...options, id: "proj-1" });
    if (!c.ok) throw new Error(c.problem.message);
    const newer = `${JSON.stringify({ ...readJson(), schemaVersion: 3 })}\n`;
    writeFileSync(projectFilePath(folder), newer);
    const opened = openProject(folder, options);
    expect(!opened.ok && opened.problem.code).toBe("unsupported-schema");
    expect(!opened.ok && opened.problem.message).toMatch(/schema version 3; this Atomic Agent reads versions 1 and 2\. Update Atomic Agent/);
    const w = commitProject(folder, "proj-1", { revision: 1, decisionSeq: c.opened.decisionSeq }, c.opened.project, options);
    expect(!w.ok && w.problem.code).toBe("unsupported-schema");
    expect(readFileSync(projectFilePath(folder), "utf8")).toBe(newer);
  });

  it("an embedded (pre-store) session migrates straight to version 2 without losing anything", () => {
    const projects = createSessionProjectStore({ stateDir, records: stateDirProjectRecords(stateDir) });
    const state = normalizeSessionState({ ...fixture.session, workingDir: folder }) as SessionState;
    state.project = project();
    const dbFile = join(stateDir, "sessions.sqlite");
    const old = new SessionStore({ dbFile });
    old.save(state);
    old.close();
    const store = new SessionStore({ dbFile, projectStore: projects });
    try {
      const opened = store.load(state.id)!;
      expect(opened.project).toEqual(state.project);
      expect(readJson().schemaVersion).toBe(2);
      store.save(opened);
      expect(store.load(state.id)!.project).toEqual(state.project);
    } finally {
      store.close();
    }
  });
});
