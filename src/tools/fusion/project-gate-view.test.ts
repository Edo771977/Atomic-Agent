import { describe, expect, it } from "vitest";

import { applyProjectDecision, applyProjectUpdate, gateVersion, type ProjectState, type ProjectUpdate } from "../../session/session-project.js";
import { estimatePlan } from "./project-estimate.js";
import { projectGateChanged, projectGateView } from "./project-gate-view.js";

const NOW = 1_700_000_000_000;
const up = (p: ProjectState | undefined, u: ProjectUpdate): ProjectState => {
  const r = applyProjectUpdate(p, u, NOW);
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
};
const brief: ProjectUpdate = { kind: "brief", brief: { what: "A game", users: "Kids", how: "HTML", successCriteria: ["Runs"] }, draftedAfterUntrusted: true };
const row = (taskId: string, milestoneId: string, estCostUsd: number) => ({
  taskId, title: taskId, milestoneId, worker: "local:a", reviewer: "cloud:r", reason: "preset", basis: "preset" as const, samples: 0, estCostUsd, estMs: 1000,
});
const plan: ProjectUpdate = {
  kind: "plan",
  milestones: [{ id: "m1", title: "Base", kind: "base" }, { id: "m2", title: "UI", kind: "ui" }],
  rows: [row("t1", "m1", 1), row("t2", "m2", 2)],
  detail: "compact",
};

describe("projectGateView (issue #39)", () => {
  it("a brief gate: the brief with its taint flag, the brief's verdicts, no plan", () => {
    const project = up(undefined, brief);
    const view = projectGateView({ sessionId: "s", project, estimate: null, selectable: { workers: [], reviewers: [] } });
    expect(view).toMatchObject({
      schema: 1, sessionId: "s", gate: { kind: "brief" }, version: 1,
      allowedVerdicts: ["approve", "edit", "cancel"], cancelled: false, plan: null, milestones: [], violations: [],
      brief: { draftedAfterUntrusted: true, status: "draft" },
      expectation: { kind: "await_person", gate: { kind: "brief" } },
    });
  });

  it("a plan gate carries the plan's taint flag", () => {
    const approvedBrief = applyProjectDecision(up(undefined, brief), { gate: { kind: "brief" }, version: 1, verdict: "approve" }, { now: NOW });
    if (!approvedBrief.ok) throw new Error("x");
    const project = up(approvedBrief.project, { ...plan, draftedAfterUntrusted: true } as ProjectUpdate);
    const view = projectGateView({ sessionId: "s", project, estimate: null, selectable: { workers: [], reviewers: [] } });
    expect(view.plan!.draftedAfterUntrusted).toBe(true);
  });

  it("a plan gate: rows with selectable members, milestone estimates, wave totals and violations hard first", () => {
    const approvedBrief = applyProjectDecision(up(undefined, brief), { gate: { kind: "brief" }, version: 1, verdict: "approve" }, { now: NOW });
    if (!approvedBrief.ok) throw new Error("x");
    const project = up(approvedBrief.project, plan);
    const estimate = estimatePlan(project.plan!.rows, {
      isLocal: () => false, turnBudgetUsd: 1.5, dailyRemainingUsd: 2.5, localSlots: 1,
    });
    const view = projectGateView({ sessionId: "s", project, estimate, selectable: { workers: ["local:a", "cloud:b"], reviewers: ["cloud:r", "local:a"] } });
    expect(view.version).toBe(gateVersion(project));
    expect(view.plan!.rows[0]).toMatchObject({ taskId: "t1", selectableWorkers: ["local:a", "cloud:b"], selectableReviewers: ["cloud:r"] });
    expect(view.plan!.totals).toEqual(estimate.totals);
    expect(view.milestones.map((m) => [m.id, m.estCostUsd, m.estMs])).toEqual([["m1", 1, 1000], ["m2", 2, 1000]]);
    expect(view.violations.map((v) => [v.kind, v.severity])).toEqual([["turn-budget", "hard"], ["daily-limit", "warn"]]);
    expect(view.violations[0]).toMatchObject({ milestoneId: "m2" });
    expect(view.violations[0]!.message).toMatch(/turn budget/);
  });

  it("a cancelled project offers no verdicts", () => {
    const project = up(undefined, brief);
    const cancelled = applyProjectDecision(project, { gate: { kind: "brief" }, version: 1, verdict: "cancel" }, { now: NOW });
    if (!cancelled.ok) throw new Error("x");
    const view = projectGateView({ sessionId: "s", project: cancelled.project, estimate: null, selectable: { workers: [], reviewers: [] } });
    expect(view).toMatchObject({ cancelled: true, allowedVerdicts: [] });
  });

  it("projectGateChanged: gate kind, milestone id, version or cancel", () => {
    const a = up(undefined, brief);
    expect(projectGateChanged(a, a)).toBe(false);
    expect(projectGateChanged(undefined, a)).toBe(true);
    expect(projectGateChanged(a, { ...a })).toBe(false);
    expect(projectGateChanged(a, up(a, brief))).toBe(true);
    expect(projectGateChanged(a, { ...a, gate: { kind: "none" } })).toBe(true);
    expect(projectGateChanged(a, { ...a, cancelledAt: 1 })).toBe(true);
  });
});
