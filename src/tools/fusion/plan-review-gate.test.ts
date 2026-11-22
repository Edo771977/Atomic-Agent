import { describe, expect, it, vi } from "vitest";

import { parseTeamMember, type TeamMember } from "../../llm/run-mode/fusion-team.js";
import { applyProjectDecision, applyProjectUpdate, gateVersion, type ProjectState, type ProjectUpdate } from "../../session/session-project.js";
import type { ToolContext } from "../tool-registry.js";
import type { EscalationComplete } from "./escalation.js";
import { PLAN_REVIEW_DIMENSIONS, type PlanReviewResult } from "./plan-review-record.js";
import { createPlanReview, type PlanReviewDeps } from "./plan-reviewer.js";
import { PROJECT_UPDATE_DETAIL, buildProjectTools, type ProjectPlanContext, type ProjectToolDeps } from "./project-tools.js";

/**
 * Issue #118: `project.plan` asks the plan reviewer before the plan gate
 * reaches the person. A fail goes back to the director in the tool's
 * result for at most N rounds; then the gate reaches the person with the
 * notes. Fake reviewers only: nothing leaves the process.
 */
const NOW = 1_700_000_000_000;
const m = (ref: string): TeamMember => parseTeamMember(ref)!;
const worker = m("local:small");
const context: ProjectPlanContext = {
  workers: [worker], reviewers: [], defaultWorker: worker, reviewerFor: () => null, reviewOn: false, records: [],
  pricing: () => undefined, tokensPerSecond: () => null, isLocal: () => true, minSamples: 2, days: 30, now: NOW,
};

function approvedBrief(criteria: string[] = ["Runs offline", "Arrow keys steer"]): ProjectState {
  const p = applyProjectUpdate(undefined, { kind: "brief", brief: { what: "Snake", users: "Kids", how: "One page", successCriteria: criteria.map((text, i) => ({ id: `c${i + 1}`, text })) }, draftedAfterUntrusted: false }, NOW);
  if (!p.ok) throw new Error(p.error.message);
  const a = applyProjectDecision(p.project, { gate: p.project.gate, version: gateVersion(p.project)!, verdict: "approve" }, { now: NOW });
  if (!a.ok) throw new Error(a.error.message);
  return a.project;
}

const passAll = (over: Partial<Record<string, Partial<PlanReviewResult>>> = {}): string =>
  JSON.stringify({ results: PLAN_REVIEW_DIMENSIONS.map((dimension) => ({ dimension, verdict: "pass", detail: `checked ${dimension}`, taskIds: [], ...over[dimension] })) });

const check = (criteria: string[]) => ({ cmd: "node", args: ["test.js"], criteria });
/** c1 is covered, c2 by no task. */
const uncoveredPlan = {
  milestones: [{ id: "m1", title: "Build", kind: "base" }],
  tasks: [{ id: "t1", title: "Build the board in `game.js`", milestone: "m1", checks: [check(["c1"])] }],
};
const coveredPlan = {
  milestones: [{ id: "m1", title: "Build", kind: "base" }],
  tasks: [{ id: "t1", title: "Build the board and keys in `game.js`", milestone: "m1", checks: [check(["c1", "c2"])] }],
};

function reviewDeps(complete: EscalationComplete, over: Partial<PlanReviewDeps> = {}): PlanReviewDeps {
  return {
    team: () => ({ reviewers: [m("cloud:model-r")] }),
    allows: () => true,
    restricted: () => false,
    reachable: () => true,
    pinsModel: () => true,
    complete,
    pricing: () => ({ input: 1, output: 2 }),
    ...over,
  };
}

function planTool(extra: Partial<ProjectToolDeps> = {}) {
  const [, plan] = buildProjectTools({ planContext: () => context, outsideContent: () => false, ...extra });
  return plan!;
}

async function draft(project: ProjectState, args: Record<string, unknown>, extra: Partial<ProjectToolDeps>) {
  const ctx = { workingDir: "/tmp/proj", sessionId: "s1", stepIndex: 0, project, signal: new AbortController().signal } as unknown as ToolContext;
  const result = await planTool(extra).run(args, ctx);
  const update = result.details[PROJECT_UPDATE_DETAIL] as Extract<ProjectUpdate, { kind: "plan" }>;
  const folded = applyProjectUpdate(project, update, NOW);
  if (!folded.ok) throw new Error(folded.error.message);
  return { result, update, project: folded.project };
}

describe("plan reviewer at project.plan (issue #118)", () => {
  it("sends a plan with an uncovered criterion back to the director, framed, with no gate", async () => {
    const complete = vi.fn(async () => ({ content: passAll(), usage: { promptTokens: 2000, completionTokens: 200 } }));
    const { result, update, project } = await draft(approvedBrief(), uncoveredPlan, { planReview: createPlanReview(reviewDeps(complete)) });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(update.holdForReview).toBe(true);
    expect(update.planReview).toMatchObject({ outcome: "reviewed", round: 1, sentBack: true, reviewer: "cloud:model-r" });
    expect(update.planReview?.results.find((r) => r.dimension === "criteria-coverage")).toMatchObject({ verdict: "fail", detail: expect.stringContaining("c2") });
    expect(project.gate).toEqual({ kind: "none" });
    expect(result.summary).toMatch(/not shown to the person/i);
    expect(result.summary).toContain("criteria-coverage: fail");
    expect(result.summary).toContain("EXTERNAL CONTENT");
    expect(result.summary).not.toMatch(/Now reply to the person/);
  });

  it("a plan the reviewer passes reaches the person with the review recorded", async () => {
    const complete = vi.fn(async () => ({ content: passAll() }));
    const { update, project, result } = await draft(approvedBrief(), coveredPlan, { planReview: createPlanReview(reviewDeps(complete)) });
    expect(update.holdForReview).toBeUndefined();
    expect(project.gate).toEqual({ kind: "plan" });
    expect(project.plan?.review).toMatchObject({ outcome: "reviewed", round: 1, sentBack: false });
    expect(result.summary).toMatch(/plan review 1 by cloud:model-r: 8 pass/);
    expect(result.summary).toMatch(/Now reply to the person/);
  });

  it("after N rounds without a pass the gate reaches the person with the open notes", async () => {
    const complete = vi.fn(async () => ({ content: passAll() }));
    const deps = { planReview: createPlanReview(reviewDeps(complete)), planReviewRounds: () => 2 };
    let project = approvedBrief();
    for (const round of [1, 2]) {
      const step = await draft(project, uncoveredPlan, deps);
      expect(step.project.gate).toEqual({ kind: "none" });
      expect(step.project.plan?.review).toMatchObject({ round, sentBack: true });
      project = step.project;
    }
    const last = await draft(project, uncoveredPlan, deps);
    expect(complete).toHaveBeenCalledTimes(3);
    expect(last.project.gate).toEqual({ kind: "plan" });
    expect(last.project.plan?.review).toMatchObject({ round: 3, sentBack: false });
    expect(last.result.summary).toMatch(/still fails criteria-coverage after 2 rounds/);
    // The second and third reviews were shown the notes the director was asked to address.
    expect(String((complete.mock.calls[1] as unknown as [{ prompt: string }])[0].prompt)).toContain("previousNotes");
  });

  it("without a plan reviewer configured nothing changes", async () => {
    const complete = vi.fn();
    const none = createPlanReview(reviewDeps(complete as unknown as EscalationComplete, { team: () => ({ reviewers: [] }) }));
    const withDep = await draft(approvedBrief(), uncoveredPlan, { planReview: none });
    const without = await draft(approvedBrief(), uncoveredPlan, {});
    expect(complete).not.toHaveBeenCalled();
    expect(withDep.update).toEqual(without.update);
    expect(withDep.update.planReview).toBeUndefined();
    expect(withDep.result.summary).toBe(without.result.summary);
    expect(withDep.project.gate).toEqual({ kind: "plan" });
  });

  it("in a local-only folder a cloud reviewer is never asked; the review is skipped and the gate says so", async () => {
    const complete = vi.fn(async () => ({ content: passAll() }));
    const localOnly = (id: string) => id === "local";
    const { update, project, result } = await draft(approvedBrief(), uncoveredPlan, {
      planReview: createPlanReview(reviewDeps(complete, { team: () => ({ planReviewer: m("cloud:model-p"), reviewers: [m("cloud:model-r")] }), allows: localOnly, restricted: () => true })),
    });
    expect(complete).not.toHaveBeenCalled();
    expect(update.planReview).toMatchObject({ outcome: "skipped", reviewer: null, reason: expect.stringContaining("projects.constraints") });
    expect(project.gate).toEqual({ kind: "plan" });
    expect(result.summary).toMatch(/plan review skipped/);
  });

  it("in a local-only folder a local reviewer reviews", async () => {
    const complete = vi.fn(async () => ({ content: passAll() }));
    const localOnly = (id: string) => id === "local";
    const { update } = await draft(approvedBrief(), coveredPlan, {
      planReview: createPlanReview(reviewDeps(complete, { team: () => ({ planReviewer: m("cloud:model-p"), reviewers: [m("cloud:model-r"), m("local:model-l")] }), allows: localOnly, restricted: () => true, pinsModel: (id) => id !== "local" })),
    });
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ providerId: "local" }));
    expect((complete.mock.calls[0] as unknown as [{ model?: string }])[0].model).toBeUndefined();
    expect(update.planReview).toMatchObject({ outcome: "reviewed", reviewer: "local:model-l" });
  });

  it("a malformed answer is a review that did not run, said so, and never holds the plan", async () => {
    const complete = vi.fn(async () => ({ content: "{\"results\":\"all good\"}" }));
    const { update, project, result } = await draft(approvedBrief(), uncoveredPlan, { planReview: createPlanReview(reviewDeps(complete)) });
    expect(update.planReview).toMatchObject({ outcome: "not-run", sentBack: false });
    expect(project.gate).toEqual({ kind: "plan" });
    expect(result.summary).toMatch(/plan review did not run/);
  });

  it("counts the review's spend", async () => {
    const spent: Array<number | null> = [];
    const complete = vi.fn(async () => ({ content: passAll(), usage: { promptTokens: 1000, completionTokens: 100 } }));
    const { update } = await draft(approvedBrief(), coveredPlan, { planReview: createPlanReview(reviewDeps(complete, { onSpend: (_s, usd) => spent.push(usd) })) });
    expect(spent).toHaveLength(1);
    expect(spent[0]).toBeGreaterThan(0);
    expect(update.planReview?.costUsd).toBe(spent[0]);
  });
});
