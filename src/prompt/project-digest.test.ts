import { describe, expect, it } from "vitest";

import {
  applyProjectDecision,
  applyProjectUpdate,
  gateVersion,
  type ProjectState,
  type ProjectUpdate,
} from "../session/session-project.js";
import { renderProjectDigest } from "./project-digest.js";

const NOW = 1_700_000_000_000;
const up = (p: ProjectState | undefined, u: ProjectUpdate): ProjectState => {
  const r = applyProjectUpdate(p, u, NOW);
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
};
const decide = (p: ProjectState, verdict: "approve" | "edit", note?: string): ProjectState => {
  const r = applyProjectDecision(p, { gate: p.gate, version: gateVersion(p)!, verdict, ...(note === undefined ? {} : { edits: { note } }) }, { now: NOW });
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
};
const row = (taskId: string, milestoneId: string) => ({
  taskId, title: taskId, milestoneId, worker: "local:a", reviewer: null, reason: "p", basis: "preset" as const, samples: 0, estCostUsd: null, estMs: null,
});
const brief: ProjectUpdate = { kind: "brief", brief: { what: "A snake game", users: "Kids", how: "HTML", successCriteria: ["Runs offline", "Arrow keys steer"] }, draftedAfterUntrusted: false };
const plan: ProjectUpdate = {
  kind: "plan",
  milestones: [{ id: "base", title: "Board", kind: "base" }, { id: "ui", title: "Score", kind: "ui" }],
  rows: [row("board", "base"), row("score", "ui"), row("menu", "ui")],
  detail: "compact",
};

describe("renderProjectDigest (issue #39)", () => {
  it("no project: nothing", () => {
    expect(renderProjectDigest(undefined)).toBeNull();
  });

  it("a brief waiting for the person says so and not to delegate", () => {
    const text = renderProjectDigest(up(undefined, brief))!;
    expect(text).toContain("brief: draft v1 — A snake game");
    expect(text).toContain("success criteria (ids for contract checks' `criteria`):\n- c1: Runs offline\n- c2: Arrow keys steer");
    expect(text).toMatch(/gate: the brief waits for the person/);
    expect(text).toMatch(/do not delegate/i);
  });

  it("lists the brief's decisions with the person's status, to cite on plan tasks (issue #112)", () => {
    const withDecisions: ProjectUpdate = { kind: "brief", brief: { what: "A snake game", users: "Kids", how: "HTML", successCriteria: ["Runs offline"], decisions: [{ id: "d1", text: "No new dependencies" }, { id: "d2", text: "Italian UI" }] }, draftedAfterUntrusted: false };
    const p = { ...decide(up(undefined, withDecisions), "approve"), decisionStatus: { d2: "deferred" as const } };
    const text = renderProjectDigest(p)!;
    expect(text).toContain("decisions (cite each active one in a plan task's `decisions`):\n- d1: No new dependencies\n- d2: Italian UI (deferred by the person)");
    expect(renderProjectDigest(up(undefined, brief))).not.toContain("decisions");
  });

  it("an approved brief without a plan asks for the plan", () => {
    const text = renderProjectDigest(decide(up(undefined, brief), "approve"))!;
    expect(text).toMatch(/next: draft the plan with project\.plan/);
  });

  it("a running milestone names its tasks and the latest correction", () => {
    let p = decide(up(decide(up(undefined, brief), "approve"), plan), "approve");
    p = up(up(p, { kind: "milestone_run", id: "base", runId: "r1" }), { kind: "milestone", id: "base", state: "done", summary: "ok" });
    p = decide(p, "edit", "The snake must wrap at the edges.");
    const text = renderProjectDigest(p)!;
    expect(text).toContain("plan: approved v");
    expect(text).toContain("milestones: base (base) approved, ui (ui) planned");
    expect(text).toContain("next: run milestone base: delegate board");
    expect(text).toContain("correction from the person: The snake must wrap at the edges.");
  });

  it("a cancelled project says it is cancelled", () => {
    const p = up(undefined, brief);
    const r = applyProjectDecision(p, { gate: p.gate, version: 1, verdict: "cancel" }, { now: NOW });
    if (!r.ok) throw new Error("x");
    expect(renderProjectDigest(r.project)).toMatch(/cancelled/);
  });
});
