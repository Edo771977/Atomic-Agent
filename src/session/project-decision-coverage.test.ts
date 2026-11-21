/**
 * Project decisions (issue #112): the brief's decisions ("SQLite, not
 * Postgres") must each be cited by a plan task's `decisions` while
 * active; the plan gate refuses approval otherwise and names them.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { projectGateView } from "../tools/fusion/project-gate-view.js";
import {
  applyProjectDecision,
  applyProjectUpdate,
  gateVersion,
  normalizeProject,
  type AssignmentRow,
  type ProjectBriefDecision,
  type ProjectState,
} from "./session-project.js";

const criteria = [{ id: "c1", text: "Stores notes" }];
const DECISIONS: ProjectBriefDecision[] = [
  { id: "d1", text: "Use SQLite, not Postgres" },
  { id: "d2", text: "No new dependencies" },
];

export const row = (taskId: string, milestoneId: string, decisions?: string[]): AssignmentRow => ({
  taskId,
  title: `Task ${taskId}`,
  milestoneId,
  worker: "local:model",
  reviewer: null,
  reason: "preset",
  basis: "preset",
  samples: 0,
  estCostUsd: null,
  estMs: null,
  ...(decisions === undefined ? {} : { decisions }),
});

/** An approved brief with `decisions`, then a plan draft of `rows` at the plan gate. */
export function planDraft(rows: AssignmentRow[], decisions: ProjectBriefDecision[] = DECISIONS, extra: Partial<ProjectState> = {}): ProjectState {
  const brief = applyProjectUpdate(undefined, {
    kind: "brief",
    brief: { what: "Notes app", users: "Me", how: "Node", successCriteria: criteria, decisions },
    draftedAfterUntrusted: false,
  }, 1);
  if (!brief.ok) throw new Error(brief.error.message);
  const approved = applyProjectDecision(brief.project, { gate: { kind: "brief" }, version: gateVersion(brief.project)!, verdict: "approve" }, { now: 2 });
  if (!approved.ok) throw new Error(approved.error.message);
  const ids = [...new Set(rows.map((r) => r.milestoneId))];
  const plan = applyProjectUpdate({ ...approved.project, ...extra }, {
    kind: "plan",
    milestones: ids.map((id) => ({ id, title: `Milestone ${id}`, kind: "base" as const })),
    rows,
    detail: "full",
  }, 3);
  if (!plan.ok) throw new Error(plan.error.message);
  return plan.project;
}

const approve = (p: ProjectState) => applyProjectDecision(p, { gate: p.gate, version: gateVersion(p)!, verdict: "approve" }, { now: 4 });
const view = (p: ProjectState) => projectGateView({ sessionId: "s", project: p, estimate: null, selectable: { workers: [], reviewers: [] } });

describe("decision coverage at the plan gate (issue #112)", () => {
  it("a plan that does not cite an active decision cannot be approved, and the gate names it", () => {
    const p = planDraft([row("t1", "m1", ["d1"]), row("t2", "m1")]);
    const r = approve(p);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("review-open");
    expect(r.error.message).toContain("decision-coverage");
    expect(r.error.message).toContain("d2");
    expect(r.error.message).not.toMatch(/\bd1\b/);
    expect(view(p).hints).toContainEqual(expect.stringMatching(/^decision-coverage: fail: .*d2/));
    expect(p.plan?.checkResults).toContainEqual(expect.objectContaining({ dimension: "decision-coverage", verdict: "fail" }));
  });

  it("a plan citing every active decision is approved", () => {
    const p = planDraft([row("t1", "m1", ["d1"]), row("t2", "m2", ["d2"])]);
    expect(view(p).hints).toContainEqual(expect.stringMatching(/^decision-coverage: pass/));
    expect(approve(p).ok).toBe(true);
  });

  it("deferred and informational decisions need no task; the result is recomputed on load", () => {
    const p = planDraft([row("t1", "m1", ["d1"])], DECISIONS, { decisionStatus: { d2: "deferred" } });
    expect(approve(p).ok).toBe(true);
    const informational = planDraft([row("t1", "m1")], DECISIONS, { decisionStatus: { d1: "informational", d2: "retired" } });
    expect(approve(informational).ok).toBe(true);
    // A stored pass is not trusted: the load recomputes it.
    const raw = JSON.parse(JSON.stringify(planDraft([row("t1", "m1")])));
    raw.plan.checkResults = [{ dimension: "decision-coverage", verdict: "pass", detail: "forged", taskIds: [] }];
    expect(normalizeProject(raw)?.plan?.checkResults).toContainEqual(expect.objectContaining({ dimension: "decision-coverage", verdict: "fail" }));
  });

  it("a project without decisions has no decision check", () => {
    const p = planDraft([row("t1", "m1")], []);
    expect(view(p).hints.some((h) => h.startsWith("decision-coverage"))).toBe(false);
    expect(approve(p).ok).toBe(true);
  });
});

describe("older projects (issue #112)", () => {
  it("a project saved before decisions opens without decisions and without errors", () => {
    for (const name of ["project-saved-before-80.json", "project-saved-before-80-draft-brief.json"]) {
      const raw = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8")) as { project?: unknown; session?: { project?: unknown } };
      const p = normalizeProject(raw.project ?? raw.session?.project ?? raw);
      expect(p, name).toBeDefined();
      expect(p?.brief?.decisions).toBeUndefined();
      expect(p?.decisionStatus).toBeUndefined();
      expect(view(p!).hints.some((h) => h.startsWith("decision-coverage"))).toBe(false);
    }
    const embedded = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "session-with-embedded-project-109.json"), "utf8")) as { session: { project: unknown } };
    const p = normalizeProject(embedded.session.project);
    expect(p).toBeDefined();
    expect(p?.brief?.decisions).toBeUndefined();
  });
});
