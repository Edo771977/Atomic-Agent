/**
 * Issue #118: the plan reviewer's record is the runtime's. `project.plan`
 * hands it on the plan update; the fold keeps it on the plan in the
 * state dir's record, a held draft stays with the director (no gate),
 * and `project.json` neither holds nor gives it back.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PLAN_REVIEW_DIMENSIONS, planReviewBasis, type PlanReviewRecord } from "../tools/fusion/plan-review-record.js";
import { projectContent, stateDirProjectRecords } from "./project-decisions.js";
import { createProject, openProject, projectFilePath, type ProjectStoreOptions } from "./project-store.js";
import { applyProjectDecision, applyProjectUpdate, gateVersion, normalizeProject, releaseHeldPlan, type AssignmentRow, type ProjectState, type ProjectUpdate } from "./session-project.js";

const NOW = 1_700_000_000_000;
const row: AssignmentRow = { taskId: "t1", title: "Build it", milestoneId: "m1", worker: "local:small", reviewer: null, reason: "preset", basis: "preset", samples: 0, estCostUsd: 0, estMs: 1000 };

function approvedBrief(): ProjectState {
  const p = applyProjectUpdate(undefined, { kind: "brief", brief: { what: "Game", users: "Kids", how: "Node", successCriteria: ["Runs"] }, draftedAfterUntrusted: false }, NOW);
  if (!p.ok) throw new Error(p.error.message);
  const a = applyProjectDecision(p.project, { gate: p.project.gate, version: gateVersion(p.project)!, verdict: "approve" }, { now: NOW });
  if (!a.ok) throw new Error(a.error.message);
  return a.project;
}

const review = (over: Partial<PlanReviewRecord> = {}): PlanReviewRecord => ({
  outcome: "reviewed",
  reviewer: "cloud:r",
  results: PLAN_REVIEW_DIMENSIONS.map((dimension) => ({ dimension, verdict: dimension === "scope" ? "fail" : "pass", detail: "d", taskIds: [] })),
  round: 1,
  sentBack: false,
  basis: planReviewBasis([row], ["m1"]),
  costUsd: 0.02,
  ...over,
});

const planUpdate = (extra: Partial<Extract<ProjectUpdate, { kind: "plan" }>> = {}): ProjectUpdate => ({
  kind: "plan", milestones: [{ id: "m1", title: "Build", kind: "base" }], rows: [row], detail: "compact", ...extra,
});

function fold(project: ProjectState, update: ProjectUpdate): ProjectState {
  const r = applyProjectUpdate(project, update, NOW);
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
}

describe("plan review on the plan (issue #118)", () => {
  it("keeps the runtime's review on the plan and opens the gate", () => {
    const p = fold(approvedBrief(), planUpdate({ planReview: review() }));
    expect(p.gate).toEqual({ kind: "plan" });
    expect(p.plan?.review).toEqual(review());
    expect(normalizeProject(JSON.parse(JSON.stringify(p)))).toEqual(p);
  });

  it("a draft held for the director's revision opens no gate and keeps its round", () => {
    const p = fold(approvedBrief(), planUpdate({ planReview: review({ sentBack: true }), holdForReview: true }));
    expect(p.gate).toEqual({ kind: "none" });
    expect(p.plan).toMatchObject({ status: "draft", review: { sentBack: true, round: 1 } });
  });

  it("a plan update without a review drops an earlier one", () => {
    const p = fold(fold(approvedBrief(), planUpdate({ planReview: review() })), planUpdate());
    expect(p.plan?.review).toBeUndefined();
  });

  it("a malformed review reads as none", () => {
    const p = fold(approvedBrief(), planUpdate({ planReview: { ...review(), results: [] } }));
    expect(p.plan?.review).toBeUndefined();
  });
});

describe("plan review and project.json (issue #118, #109)", () => {
  let folder: string;
  let stateDir: string;
  let options: ProjectStoreOptions;
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "aa-plan-review-"));
    stateDir = mkdtempSync(join(tmpdir(), "aa-plan-review-state-"));
    options = { stateDir, records: stateDirProjectRecords(stateDir), now: () => NOW };
  });
  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("is never written to the file, and the record keeps it", () => {
    const p = fold(approvedBrief(), planUpdate({ planReview: review() }));
    expect(projectContent(p).plan?.review).toBeUndefined();
    const created = createProject(folder, p, options);
    if (!created.ok) throw new Error(created.problem.message);
    const file = JSON.parse(readFileSync(projectFilePath(folder), "utf8"));
    expect(file.project.plan.review).toBeUndefined();
    expect(created.opened.project.plan?.review).toEqual(review());
  });

  it("a forged review in project.json is ignored", () => {
    // The record says the reviewer failed scope; a file edit claims an all-pass review.
    const p = fold(approvedBrief(), planUpdate({ planReview: review() }));
    const created = createProject(folder, p, options);
    if (!created.ok) throw new Error(created.problem.message);
    const file = JSON.parse(readFileSync(projectFilePath(folder), "utf8"));
    const forged = review({ results: PLAN_REVIEW_DIMENSIONS.map((dimension) => ({ dimension, verdict: "pass" as const, detail: "fine", taskIds: [] })) });
    file.project.plan.review = forged;
    file.project.plan.reviewOverride = { note: "ok", at: NOW, blocks: [] };
    writeFileSync(projectFilePath(folder), JSON.stringify(file));
    const opened = openProject(folder, options);
    if (!opened.ok) throw new Error(opened.problem.message);
    expect(opened.opened.project.plan?.review).toEqual(review());
    expect(opened.opened.project.plan?.reviewOverride).toBeUndefined();
    expect(opened.opened.stored.project.plan?.review).toBeUndefined();
  });
});

describe("a held plan when the turn ends (review round, issue #118)", () => {
  it("opens the plan gate with the open notes, as if the rounds had run out", () => {
    const held = fold(approvedBrief(), planUpdate({ planReview: review({ sentBack: true }), holdForReview: true }));
    const released = releaseHeldPlan(held);
    expect(released?.gate).toEqual({ kind: "plan" });
    expect(released?.plan?.review).toMatchObject({ sentBack: false, heldAtTurnEnd: true });
    expect(normalizeProject(JSON.parse(JSON.stringify(released)))).toEqual(released);
  });
  it("leaves any other project alone", () => {
    expect(releaseHeldPlan(fold(approvedBrief(), planUpdate({ planReview: review() })))).toBeUndefined();
    expect(releaseHeldPlan(undefined)).toBeUndefined();
  });
});
