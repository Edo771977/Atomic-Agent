/**
 * Issue #109: a project's record (the runtime's state and the person's
 * decisions) and how the folder's author content is taken against it.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  gateContentHash,
  memoryProjectRecords,
  projectContent,
  resolveProject,
  stateDirProjectRecords,
  type ProjectRecord,
} from "./project-decisions.js";
import { gateVersion, normalizeProject, type ProjectState } from "./session-project.js";

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "session-with-embedded-project-109.json"), "utf8")) as {
  session: { project: unknown };
};
const project = (): ProjectState => normalizeProject(fixture.session.project)!;
const record = (state: ProjectState): ProjectRecord => ({ version: 1, folder: "/f", id: "p", seq: 1, state, decisions: [] });
/** m2 running under the approved plan, no gate open. */
const running = (): ProjectState => {
  const p = project();
  return { ...p, gate: { kind: "none" }, milestones: p.milestones.map((m) => (m.id === "m2" ? { ...m, state: "in_progress" as const } : m)) };
};

describe("project content and record (issue #109)", () => {
  it("the file's content carries no person decision", () => {
    const content = projectContent(project());
    expect(content.gate).toEqual({ kind: "none" });
    expect(content.brief?.status).toBe("draft");
    expect(content.plan?.status).toBe("draft");
    for (const m of content.milestones) {
      expect(["approved", "reviewed"]).not.toContain(m.state);
      expect(m.reviewOverride).toBeUndefined();
      expect(m.corrections).toBeUndefined();
    }
  });

  it("the file's mirror plus the record is the record's project", () => {
    const p = project();
    expect(resolveProject(projectContent(p), record(p), 1)).toEqual(p);
  });

  it("with no record (another machine, a copy) the author content opens as a draft and execution starts over", () => {
    const r = resolveProject(projectContent(project()), null, 1);
    expect(r.gate).toEqual({ kind: "brief" });
    expect(r.brief?.status).toBe("draft");
    expect(r.brief?.what).toBe("A puzzle game");
    expect(r.plan?.status).toBe("draft");
    expect(r.plan?.rows.map((x) => x.taskId)).toEqual(["t1", "t2", "t3"]);
    expect(r.milestones.map((m) => `${m.state}:${m.runIds.length}:${m.criteriaFacts?.length ?? 0}`)).toEqual(["planned:0:0", "planned:0:0", "planned:0:0"]);
    expect(r.changedOutside).toEqual(["brief", "plan"]);
  });

  it("a brief edited in the file reopens the brief gate as an untrusted draft; nothing downstream stays approved", () => {
    const p = running();
    const content = projectContent(p);
    const r = resolveProject({ ...content, brief: { ...content.brief!, what: "A puzzle game with ads" } }, record(p), 1);
    expect(r.gate).toEqual({ kind: "brief" });
    expect(r.brief).toMatchObject({ status: "draft", what: "A puzzle game with ads", draftedAfterUntrusted: true });
    expect(r.brief!.version).toBeGreaterThan(p.brief!.version);
    expect(r.plan?.status).toBe("draft");
    expect(r.changedOutside).toEqual(["brief"]);
  });

  it("plan rows edited in the file reopen the plan gate at a higher version", () => {
    const p = running();
    const content = projectContent(p);
    const rows = content.plan!.rows.map((x) => (x.taskId === "t3" ? { ...x, worker: "cloud:expensive" } : x));
    const r = resolveProject({ ...content, plan: { ...content.plan!, rows } }, record(p), 1);
    expect(r.gate).toEqual({ kind: "plan" });
    expect(r.plan).toMatchObject({ status: "draft", draftedAfterUntrusted: true });
    expect(r.plan!.version).toBeGreaterThan(p.plan!.version);
    expect(r.milestones[0]?.state).toBe("reviewed");
    expect(r.changedOutside).toEqual(["plan"]);
  });

  it("statuses, runs and evidence written in the file are never read", () => {
    const p = running();
    const content = projectContent(p);
    const forged: ProjectState = {
      ...content,
      brief: { ...content.brief!, status: "approved" },
      milestones: content.milestones.map((m) => ({ ...m, state: "reviewed" as const, runIds: ["x"], criteriaFacts: [{ id: "c1", state: "passed" as const }] })),
    };
    expect(resolveProject(forged, record(p), 1)).toEqual(p);
    expect(resolveProject(forged, null, 1).milestones.every((m) => m.state === "planned" && m.runIds.length === 0)).toBe(true);
  });
});

describe("the record store (issue #109)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  for (const [name, make] of [
    ["state dir", () => {
      const dir = mkdtempSync(join(tmpdir(), "aa-records-"));
      dirs.push(dir);
      return stateDirProjectRecords(dir, () => 5);
    }],
    ["memory", () => memoryProjectRecords(() => 5)],
  ] as const) {
    it(`${name}: the same gate decided twice is "already decided"; a stale write is a conflict; a decision clears its gate's outside flag`, () => {
      const store = make();
      const p: ProjectState = { ...project(), changedOutside: ["milestone:m2", "plan"] };
      expect(store.write("/f", "p1", 0, p)).toEqual({ ok: true, seq: 1 });
      const decision = { gate: p.gate, version: gateVersion(p)!, verdict: "approve" as const, hash: gateContentHash(p, p.gate)! };
      expect(store.write("/f", "p1", 1, p, decision)).toEqual({ ok: true, seq: 2 });
      const again = store.write("/f", "p1", 1, p, decision);
      expect(!again.ok && again.problem.code).toBe("already-decided");
      const stale = store.write("/f", "p1", 1, p);
      expect(!stale.ok && stale.problem.code).toBe("conflict");
      const read = store.read("/f", "p1");
      if (!read.ok || read.record === null) throw new Error("no record");
      expect(read.record.seq).toBe(2);
      expect(read.record.decisions).toEqual([{ seq: 2, at: 5, ...decision }]);
      expect(read.record.state.changedOutside).toEqual(["plan"]);
    });
  }

  it("refuses an id that is not a safe file name", () => {
    const dir = mkdtempSync(join(tmpdir(), "aa-records-"));
    dirs.push(dir);
    expect(() => stateDirProjectRecords(dir).read("/f", "../x")).toThrow(/safe file name/);
  });
});
