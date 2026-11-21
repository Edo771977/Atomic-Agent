/**
 * Issue #109: person decisions kept apart from a project's content and
 * bound to the content each gate covered.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  decisionOverlay,
  gateContentHash,
  memoryDecisionStore,
  projectContent,
  resolveProject,
  stateDirDecisionStore,
} from "./project-decisions.js";
import { applyProjectDecision, gateVersion, normalizeProject, type ProjectState } from "./session-project.js";

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "session-with-embedded-project-109.json"), "utf8")) as {
  session: { project: unknown };
};
const project = (): ProjectState => normalizeProject(fixture.session.project)!;

describe("project content and decisions (issue #109)", () => {
  it("content carries no person decision", () => {
    const content = projectContent(project());
    expect(content.gate).toEqual({ kind: "none" });
    expect(content.brief?.status).toBe("draft");
    expect(content.brief?.approvedAt).toBeUndefined();
    expect(content.plan?.status).toBe("draft");
    expect(content.plan?.approvedAt).toBeUndefined();
    for (const m of content.milestones) {
      expect(["approved", "reviewed"]).not.toContain(m.state);
      expect(m.reviewOverride).toBeUndefined();
      expect(m.corrections).toBeUndefined();
    }
    expect(content).not.toHaveProperty("approvedCriteria");
    expect(content).not.toHaveProperty("briefApprovals");
    // Evidence is content.
    expect(content.milestones[0]?.criteriaFacts?.[0]).toEqual({ id: "c1", state: "passed", reservation: "only a lint-warned check supports it" });
    expect(content.milestones[0]?.attachments).toHaveLength(1);
  });

  it("content plus its recorded decisions is the project again", () => {
    const p = project();
    expect(resolveProject(projectContent(p), decisionOverlay(p))).toEqual(p);
  });

  it("with no decisions (another machine) every gate waits and the content stays", () => {
    const p = project();
    const r = resolveProject(projectContent(p), null);
    expect(r.gate).toEqual({ kind: "brief" });
    expect(r.brief?.status).toBe("draft");
    expect(r.plan?.status).toBe("draft");
    expect(r.milestones.map((m) => m.state)).toEqual(["done", "done", "planned"]);
    expect(r.milestones[1]?.criteriaFacts).toEqual(p.milestones[1]?.criteriaFacts);
    expect(r.changedOutside).toEqual(["brief", "plan"]);
  });

  it("a brief changed after its approval waits again, and nothing downstream stays approved", () => {
    const p = project();
    const content = projectContent(p);
    const edited: ProjectState = { ...content, brief: { ...content.brief!, what: "A puzzle game with ads" } };
    const r = resolveProject(edited, decisionOverlay(p));
    expect(r.gate).toEqual({ kind: "brief" });
    expect(r.brief?.status).toBe("draft");
    expect(r.brief!.version).toBeGreaterThan(p.brief!.version);
    expect(r.plan?.status).toBe("draft");
    expect(r.milestones.some((m) => m.state === "approved" || m.state === "in_progress")).toBe(false);
    expect(r.changedOutside).toEqual(expect.arrayContaining(["brief", "plan"]));
  });

  it("a plan changed after its approval waits at the plan gate at a higher version; a reviewed milestone keeps its verdict", () => {
    const p = project();
    const content = projectContent(p);
    const rows = content.plan!.rows.map((r) => (r.taskId === "t3" ? { ...r, worker: "cloud:expensive" } : r));
    const r = resolveProject({ ...content, plan: { ...content.plan!, rows } }, decisionOverlay(p));
    expect(r.gate).toEqual({ kind: "plan" });
    expect(r.plan?.status).toBe("draft");
    expect(r.plan!.version).toBeGreaterThan(p.plan!.version);
    expect(r.milestones[0]?.state).toBe("reviewed");
    expect(r.milestones[0]?.reviewOverride?.note).toBe("reviewer offline; checked by hand");
    // m3's task is the one that changed: its row is part of what its gate covers.
    expect(r.changedOutside).toEqual(["plan", "milestone:m3"]);
  });

  it("forged milestone evidence reopens that milestone's gate at a new version", () => {
    const p = project();
    const content = projectContent(p);
    const milestones = content.milestones.map((m) => (m.id === "m1" ? { ...m, criteriaFacts: [{ id: "c1", state: "passed" as const }, { id: "c2", state: "passed" as const }] } : m));
    const r = resolveProject({ ...content, milestones }, decisionOverlay(p));
    expect(r.milestones[0]?.state).toBe("done");
    expect(r.milestones[0]?.reviewOverride).toBeUndefined();
    expect(r.gate).toEqual({ kind: "milestone", id: "m1" });
    expect(gateVersion(r)).toBeGreaterThan(gateVersion(p)!);
    expect(r.changedOutside).toEqual(["milestone:m1"]);
    // A card shown before the change cannot approve it.
    const stale = applyProjectDecision(r, { gate: { kind: "milestone", id: "m1" }, version: gateVersion(p)!, verdict: "approve" }, { now: 1 });
    expect(stale.ok).toBe(false);
  });

  it("statuses written into the file by hand approve nothing", () => {
    const p = project();
    const content = projectContent(p);
    const forged = { ...content, brief: { ...content.brief!, status: "approved" as const }, plan: { ...content.plan!, status: "approved" as const }, gate: { kind: "none" as const } };
    const r = resolveProject(forged, null);
    expect(r.brief?.status).toBe("draft");
    expect(r.plan?.status).toBe("draft");
  });
});

describe("the decision store (issue #109)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  for (const [name, make] of [
    ["state dir", () => {
      const dir = mkdtempSync(join(tmpdir(), "aa-decisions-"));
      dirs.push(dir);
      return stateDirDecisionStore(dir, () => 5);
    }],
    ["memory", () => memoryDecisionStore(() => 5)],
  ] as const) {
    it(`${name}: the same gate decided twice is "already decided"; a stale write is a conflict`, () => {
      const store = make();
      const p = project();
      expect(store.record("p1", 0, p)).toEqual({ ok: true, seq: 1 });
      const decision = { gate: p.gate, version: gateVersion(p)!, verdict: "approve" as const, hash: gateContentHash(p, p.gate)! };
      expect(store.record("p1", 1, p, decision)).toEqual({ ok: true, seq: 2 });
      const again = store.record("p1", 1, p, decision);
      expect(again.ok).toBe(false);
      if (!again.ok) expect(again.problem.code).toBe("already-decided");
      const stale = store.record("p1", 1, p);
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.problem.code).toBe("conflict");
      const read = store.read("p1");
      expect(read.seq).toBe(2);
      expect(read.decisions).toEqual([{ seq: 2, at: 5, ...decision }]);
      expect(resolveProject(projectContent(p), read.overlay)).toEqual(p);
    });
  }

  it("refuses an id that is not a safe file name", () => {
    const dir = mkdtempSync(join(tmpdir(), "aa-decisions-"));
    dirs.push(dir);
    expect(() => stateDirDecisionStore(dir).read("../x")).toThrow(/safe file name/);
  });
});
