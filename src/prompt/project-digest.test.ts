import { projectLessonDataBlock, projectLessonSelection } from "./project-lessons-data.js";
import { PROJECT_LIMITS } from "../session/project-limits.js";
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
  it("frames always lessons as project data for the director", () => {
    const project = decide(up(undefined, brief), "approve");
    const lessons = [{ id: "storage", title: "Storage", always: true, sections: { triedAndRuledOut: "Use X", decided: "Use Y", watchOut: "" } }];
    expect(renderProjectDigest(project, lessons)).toMatch(/project\.plan[\s\S]*EXTERNAL CONTENT[\s\S]*"always":true[\s\S]*Use X/);
  });

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

describe("renderProjectDigest and a plan held for the plan reviewer (issue #118)", () => {
  it("says to revise the plan, not to reply, and lists the reviewer's notes as data", () => {
    const approved = decide(up(undefined, brief), "approve");
    const results = ["criteria-coverage", "task-completeness", "dependencies", "size", "verifiability", "scope", "numbers", "decisions", "lessons"].map((dimension) => ({
      dimension, verdict: dimension === "scope" || dimension === "lessons" ? "fail" as const : "pass" as const, detail: dimension === "scope" ? "drops the level editor" : dimension === "lessons" ? "quotes previously active lesson text" : "ok", taskIds: [],
    }));
    const held = up(approved, { ...plan, planReview: { outcome: "reviewed", reviewer: "c:r", results: results as never, round: 1, sentBack: true, basis: "0123456789abcdef", costUsd: null }, holdForReview: true } as ProjectUpdate);
    const text = renderProjectDigest(held)!;
    expect(text).toMatch(/next: revise the plan with project\.plan to address the plan reviewer's notes/);
    expect(text).not.toMatch(/next: draft the plan with project\.plan, then reply/);
    expect(text).toContain("plan review: scope: fail: drops the level editor");
    expect(text).toContain("EXTERNAL CONTENT");
    expect(text).toContain("plan review: lessons: fail");
    expect(text).not.toContain("quotes previously active lesson text");
  });
});

it("bounds escaped lesson data and reports the number omitted", () => {
  const selection = projectLessonSelection(Array.from({ length: 15 }, (_, index) => ({
    id: String(index), title: "T".repeat(400), always: index === 14, hash: "",
    source: "person", touches: [], declaredStatus: "active", approvedByPerson: false,
    sections: { decided: "\\".repeat(600), watchOut: "\\".repeat(600), triedAndRuledOut: "\\".repeat(600) },
  })));
  expect(selection.data[0]).toMatchObject({ id: "14" });
  expect(selection.data[0]!.title).toHaveLength(PROJECT_LIMITS.title);
  expect(selection.omitted).toBeGreaterThan(3);
  const text = projectLessonDataBlock(selection.data, selection.omitted)!;
  expect(text.length).toBeLessThanOrEqual(8000);
  expect(text).toContain(`${selection.omitted} more lessons were not shown`);
});
