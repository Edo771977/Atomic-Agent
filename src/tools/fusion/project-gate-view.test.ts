import { describe, expect, it } from "vitest";

import { join, resolve } from "node:path";

import { PROJECT_RUNS_DIR_NAME, applyProjectDecision, applyProjectUpdate, gateVersion, type ProjectState, type ProjectUpdate } from "../../session/session-project.js";
import { FUSION_RUNS_DIR_NAME } from "./run-checkpoint.js";
import { estimatePlan } from "./project-estimate.js";
import { evaluatePlanChecks, planCheckHint } from "./plan-checks.js";
import { CHANGED_OUTSIDE_HINT, projectGateChanged, projectGateView } from "./project-gate-view.js";

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
  it("counts legacy facts and warns only about uncited verification claims", () => {
    const project = up(undefined, brief);
    project.milestones = [{
      id: "m1", title: "Base", kind: "base", state: "done", runIds: [], updatedAt: NOW,
      summary: "Verified [c1]. Il timer funziona.",
      criteriaFacts: [{ id: "c1", state: "passed" }],
    }];
    const view = projectGateView({ sessionId: "s", project, estimate: null, selectable: { workers: [], reviewers: [] } });
    expect(view.milestones[0]?.criteriaBasisSummary).toEqual({ check: 0, vision: 0, person: 0, unrecorded: 1 });
    expect(view.milestones[0]?.directorReportWarnings).toEqual(["Il timer funziona."]);
  });
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

  it("the brief keeps its criteria texts for older surfaces and carries the ids beside them", () => {
    const project = up(undefined, { kind: "brief", brief: { what: "A game", users: "Kids", how: "HTML", successCriteria: ["Runs", { id: "keys", text: "Keys steer" }] }, draftedAfterUntrusted: false });
    const view = projectGateView({ sessionId: "s", project, estimate: null, selectable: { workers: [], reviewers: [] } });
    expect(view.brief!.successCriteria).toEqual(["Runs", "Keys steer"]);
    expect(view.brief!.criteria).toEqual([{ id: "c1", text: "Runs" }, { id: "keys", text: "Keys steer" }]);
  });

  it("a milestone carries its attachments and criteria facts (issue #40)", () => {
    expect(PROJECT_RUNS_DIR_NAME).toBe(FUSION_RUNS_DIR_NAME);
    const ok = <T extends { ok: boolean }>(r: T) => { if (!r.ok) throw new Error(JSON.stringify(r)); return (r as unknown as { project: ProjectState }).project; };
    let project = ok(applyProjectDecision(up(undefined, brief), { gate: { kind: "brief" }, version: 1, verdict: "approve" }, { now: NOW }));
    project = up(project, plan);
    project = ok(applyProjectDecision(project, { gate: { kind: "plan" }, version: gateVersion(project)!, verdict: "approve" }, { now: NOW }));
    project = up(project, { kind: "milestone_run", id: "m1", runId: "run-1" });
    const stateDir = resolve("/state");
    const path = join(stateDir, "fusion-runs", "run-1", "shots", "t1-1.jpg");
    project = ok(applyProjectUpdate(project, {
      kind: "milestone", id: "m1", state: "done", summary: "s",
      attachments: [{ path, caption: "Board", criteria: ["c1"] }],
      criteriaFacts: [{ id: "c1", state: "unverified", why: "no vision reviewer" }],
    }, NOW, { stateDir }));
    const view = projectGateView({ sessionId: "s", project, estimate: null, selectable: { workers: [], reviewers: [] } });
    expect(view.milestones[0]).toMatchObject({
      attachments: [{ path, caption: "Board", criteria: ["c1"] }],
      criteriaFacts: [{ id: "c1", state: "unverified", why: "no vision reviewer" }],
    });
    expect(view.milestones[1]!.attachments).toBeUndefined();
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

describe("projectGateView hints and editable rows (issue #54)", () => {
  const planGate = (): ProjectState => {
    const approvedBrief = applyProjectDecision(up(undefined, brief), { gate: { kind: "brief" }, version: 1, verdict: "approve" }, { now: NOW });
    if (!approvedBrief.ok) throw new Error("x");
    return up(approvedBrief.project, plan);
  };

  const checkHints = () => evaluatePlanChecks(plan.rows, [{ id: "c1", text: "Runs" }]).map(planCheckHint);

  it("hints at configuring reviewers when none are, and leaves review behaviour alone", () => {
    const view = projectGateView({ sessionId: "s", project: planGate(), estimate: null, selectable: { workers: ["local:a", "cloud:b"], reviewers: [] }, reviewersConfigured: false });
    expect(view.hints).toEqual([...checkHints(), "no reviewers configured: add llm.runMode.fusion.team.reviewers to have each task reviewed"]);
    expect(view.plan!.editable).toBe(true);
    expect(view.plan!.rows.map((r) => r.reviewer)).toEqual(["cloud:r", "cloud:r"]);
  });

  it("is not editable, with a hint, when every row has only its own worker and no reviewer to pick", () => {
    const view = projectGateView({ sessionId: "s", project: planGate(), estimate: null, selectable: { workers: ["local:a"], reviewers: [] }, reviewersConfigured: false });
    expect(view.plan!.editable).toBe(false);
    expect(view.hints).toContain("only one worker available: configure llm.runMode.fusion.team to choose");
  });

  it("says no other member is reachable, not to configure a team, when the team has members that cannot answer", () => {
    const view = projectGateView({ sessionId: "s", project: planGate(), estimate: null, selectable: { workers: ["local:a"], reviewers: [] }, reviewersConfigured: true, otherMembersConfigured: true });
    expect(view.plan!.editable).toBe(false);
    expect(view.hints).toEqual([...checkHints(), "no other team member is reachable now: the rows keep their worker"]);
  });

  it("names each milestone whose verdict the draft plan resets (issue #77)", () => {
    const project = planGate();
    const reset: ProjectState = { ...project, plan: { ...project.plan!, verdictResets: ["m2"] } };
    const view = projectGateView({ sessionId: "s", project: reset, estimate: null, selectable: { workers: ["local:a"], reviewers: ["cloud:r"] }, reviewersConfigured: true });
    expect(view.hints).toEqual([...checkHints(), "verdict reset: UI"]);
    const elsewhere = projectGateView({ sessionId: "s", project: { ...reset, gate: { kind: "none" } }, estimate: null, selectable: { workers: ["local:a"], reviewers: ["cloud:r"] }, reviewersConfigured: true });
    expect(elsewhere.hints).toEqual([]);
  });

  it("names each milestone that kept its verdict but lost criteria evidence (issue #83)", () => {
    const project = planGate();
    const retired: ProjectState = { ...project, plan: { ...project.plan!, verdictResets: ["m2"], evidenceRetired: ["m1"] } };
    const view = projectGateView({ sessionId: "s", project: retired, estimate: null, selectable: { workers: ["local:a"], reviewers: ["cloud:r"] }, reviewersConfigured: true });
    expect(view.hints).toEqual([...checkHints(), "verdict reset: UI", "evidence retired: Base"]);
  });

  it("is editable with check hints when there is a choice and reviewers are configured", () => {
    const view = projectGateView({ sessionId: "s", project: planGate(), estimate: null, selectable: { workers: ["local:a"], reviewers: ["cloud:r"] }, reviewersConfigured: true });
    expect(view.plan!.editable).toBe(true);
    expect(view.hints).toEqual(checkHints());
  });

  it("gives no plan hints at the brief gate", () => {
    const view = projectGateView({ sessionId: "s", project: up(undefined, brief), estimate: null, selectable: { workers: [], reviewers: [] }, reviewersConfigured: false });
    expect(view.hints).toEqual([]);
  });
});

describe("a gate whose content changed outside Atomic Agent (issue #109)", () => {
  it("is marked on the view with a hint", async () => {
    const { applyProjectUpdate } = await import("../../session/session-project.js");
    const r = applyProjectUpdate(undefined, { kind: "brief", brief: { what: "A", users: "B", how: "C", successCriteria: ["x"] }, draftedAfterUntrusted: false }, 1);
    if (!r.ok) throw new Error(r.error.message);
    const view = projectGateView({ sessionId: "s", project: { ...r.project, changedOutside: ["brief"] }, estimate: null, selectable: { workers: [], reviewers: [] } });
    expect(view.changedOutside).toBe(true);
    expect(view.hints).toContain(CHANGED_OUTSIDE_HINT);
    const clean = projectGateView({ sessionId: "s", project: r.project, estimate: null, selectable: { workers: [], reviewers: [] } });
    expect(clean.changedOutside).toBeUndefined();
  });
});
