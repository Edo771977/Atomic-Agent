import { describe, expect, it } from "vitest";

import {
  applyProjectDecision,
  applyProjectUpdate,
  gateVersion,
  type AssignmentRow,
  type ProjectState,
  type ProjectUpdate,
} from "../../session/session-project.js";
import { checkProjectDispatch, planCoversFanout } from "./project-dispatch.js";

const NOW = 1_700_000_000_000;
const up = (p: ProjectState | undefined, u: ProjectUpdate): ProjectState => {
  const r = applyProjectUpdate(p, u, NOW);
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
};
const approve = (p: ProjectState): ProjectState => {
  const r = applyProjectDecision(p, { gate: p.gate, version: gateVersion(p)!, verdict: "approve" }, { now: NOW });
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
};
const row = (taskId: string, milestoneId: string, worker = "local:model-a"): AssignmentRow => ({
  taskId, title: taskId, milestoneId, worker, reviewer: null, reason: "preset", basis: "preset", samples: 0, estCostUsd: null, estMs: null,
});
const brief: ProjectUpdate = { kind: "brief", brief: { what: "A game", users: "Kids", how: "HTML", successCriteria: ["Runs"] }, draftedAfterUntrusted: false };
const plan: ProjectUpdate = {
  kind: "plan",
  milestones: [{ id: "m1", title: "Base", kind: "base" }, { id: "m2", title: "UI", kind: "ui" }],
  rows: [row("a", "m1"), row("b", "m1", "cloud:model-b"), row("c", "m2")],
  detail: "compact",
};
const running = () => approve(up(approve(up(undefined, brief)), plan));

describe("checkProjectDispatch (issue #39)", () => {
  it("no project: the fan-out runs as before", () => {
    expect(checkProjectDispatch(undefined, ["a"])).toEqual({ kind: "no-project" });
  });

  it("refuses while the brief or the plan waits for the person, or before a plan exists", () => {
    for (const project of [up(undefined, brief), approve(up(undefined, brief)), up(approve(up(undefined, brief)), plan)]) {
      const verdict = checkProjectDispatch(project, ["a"]);
      expect(verdict.kind).toBe("refuse");
      if (verdict.kind === "refuse") expect(verdict.message).toMatch(/approv/);
    }
  });

  it("refuses a cancelled project", () => {
    const p = up(undefined, brief);
    const cancelled = applyProjectDecision(p, { gate: p.gate, version: 1, verdict: "cancel" }, { now: NOW });
    if (!cancelled.ok) throw new Error("x");
    const verdict = checkProjectDispatch(cancelled.project, ["a"]);
    expect(verdict).toMatchObject({ kind: "refuse", reason: "cancelled" });
  });

  it("admits the approved milestone's tasks and refuses a later milestone's", () => {
    expect(checkProjectDispatch(running(), ["a", "b"])).toMatchObject({ kind: "admit", milestoneId: "m1", planned: ["a", "b"], unplanned: [] });
    const later = checkProjectDispatch(running(), ["a", "c"]);
    expect(later).toMatchObject({ kind: "refuse", reason: "milestone-not-approved" });
    if (later.kind === "refuse") expect(later.message).toMatch(/m2/);
  });

  it("refuses while a milestone report waits for the person", () => {
    const reported = up(running(), { kind: "milestone", id: "m1", state: "done", summary: "ok" });
    expect(checkProjectDispatch(reported, ["a"])).toMatchObject({ kind: "refuse", reason: "awaiting-person" });
  });

  it("tasks outside the plan are admitted (they still prompt)", () => {
    expect(checkProjectDispatch(running(), ["a", "extra"])).toMatchObject({ kind: "admit", milestoneId: "m1", planned: ["a"], unplanned: ["extra"] });
    expect(checkProjectDispatch(running(), ["extra"])).toMatchObject({ kind: "admit", milestoneId: null, unplanned: ["extra"] });
  });

  it("an in-progress milestone keeps admitting its tasks (a rework round)", () => {
    const inProgress = up(running(), { kind: "milestone_run", id: "m1", runId: "r1" });
    expect(checkProjectDispatch(inProgress, ["b"])).toMatchObject({ kind: "admit", milestoneId: "m1" });
  });
});

describe("planCoversFanout", () => {
  const project = running();
  const legOf = (id: string) => (id === "b" ? "cloud:model-b" : "local:model-a");

  it("covers the same tasks on the same workers inside the approved folder", () => {
    expect(planCoversFanout(project, ["a", "b"], legOf, ["/w", "/w/src"], ["/w"])).toBe(true);
  });

  it("not when a task is outside the plan, on another worker, or writes outside the folder", () => {
    expect(planCoversFanout(project, ["a", "extra"], legOf, ["/w"], ["/w"])).toBe(false);
    expect(planCoversFanout(project, ["b"], () => "local:model-a", ["/w"], ["/w"])).toBe(false);
    expect(planCoversFanout(project, ["a"], legOf, ["/w", "/elsewhere"], ["/w"])).toBe(false);
    expect(planCoversFanout(project, [], legOf, ["/w"], ["/w"])).toBe(false);
  });

  it("only the tasks of the milestone approved or in progress count", () => {
    expect(planCoversFanout(project, ["c"], legOf, ["/w"], ["/w"])).toBe(false);
    const inProgress = up(project, { kind: "milestone_run", id: "m1", runId: "r1" });
    expect(planCoversFanout(inProgress, ["a"], legOf, ["/w"], ["/w"])).toBe(true);
  });

  it("a plan drafted after outside content counts only when approved with that warning shown", () => {
    const approvedBrief = approve(up(undefined, brief));
    const tainted = up(approvedBrief, { ...plan, draftedAfterUntrusted: true } as ProjectUpdate);
    expect(planCoversFanout(approve(tainted), ["a"], legOf, ["/w"], ["/w"])).toBe(true);
    const unshown = approve(tainted);
    const { approvedWithUntrustedWarning: _shown, ...rest } = unshown.plan!;
    expect(planCoversFanout({ ...unshown, plan: rest }, ["a"], legOf, ["/w"], ["/w"])).toBe(false);
  });
});
