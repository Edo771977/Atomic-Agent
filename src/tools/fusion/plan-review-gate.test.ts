import { describe, expect, it, vi } from "vitest";

import { parseTeamMember, type TeamMember } from "../../llm/run-mode/fusion-team.js";
import { applyProjectDecision, applyProjectUpdate, gateVersion, type ProjectState, type ProjectUpdate } from "../../session/session-project.js";
import { freshFromContent, resolveProject, type ProjectRecord } from "../../session/project-decisions.js";
import type { ToolContext } from "../tool-registry.js";
import type { EscalationComplete } from "./escalation.js";
import { PLAN_REVIEW_DIMENSIONS, type PlanReviewResult } from "./plan-review-record.js";
import { createPlanReview, type PlanReviewDeps } from "./plan-reviewer.js";
import { settleProjectGate } from "../../cli/run-project-gate.js";
import { projectGateView } from "./project-gate-view.js";
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
    const complete = vi.fn(async () => ({ content: passAll(), usage: { promptTokens: 2000, completionTokens: 200, totalTokens: 2200 } }));
    const { result, update, project } = await draft(approvedBrief(), uncoveredPlan, { planReview: createPlanReview(reviewDeps(complete)) });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(update.holdForReview).toBe(true);
    expect(update.planReview).toMatchObject({ outcome: "reviewed", round: 1, sentBack: true, reviewer: "cloud:model-r" });
    // The record keeps the model's verdict; the fact (c2 named by no check) fails it when used.
    expect(update.planReview?.results.find((r) => r.dimension === "criteria-coverage")).toMatchObject({ verdict: "pass" });
    expect(result.summary).toMatch(/criteria-coverage: fail: No task check names approved criteria: c2/);
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
    expect(result.summary).toMatch(/plan not reviewed: the review was skipped/);
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
    expect(result.summary).toMatch(/plan not reviewed: /);
  });

  it("counts the review's spend", async () => {
    const spent: Array<number | null> = [];
    const complete = vi.fn(async () => ({ content: passAll(), usage: { promptTokens: 1000, completionTokens: 100, totalTokens: 1100 } }));
    const { update } = await draft(approvedBrief(), coveredPlan, { planReview: createPlanReview(reviewDeps(complete, { onSpend: (_s, usd) => spent.push(usd) })) });
    expect(spent).toHaveLength(1);
    expect(spent[0]).toBeGreaterThan(0);
    expect(update.planReview?.costUsd).toBe(spent[0]);
  });
});

describe("plan reviewer at the plan gate (issue #118)", () => {
  /** A plan whose reviewer still fails after the rounds (0 here): at the person's gate with open notes. */
  async function atGate(plan: Record<string, unknown> = uncoveredPlan) {
    const complete = vi.fn(async () => ({ content: passAll() }));
    return (await draft(approvedBrief(), plan, { planReview: createPlanReview(reviewDeps(complete)), planReviewRounds: () => 0 })).project;
  }
  const decide = (project: ProjectState, verdict: "approve" | "approveOverReview", note?: string) =>
    applyProjectDecision(project, { gate: project.gate, version: gateVersion(project)!, verdict, ...(note === undefined ? {} : { edits: { note } }) }, { now: NOW + 1 });

  it("shows the per-dimension notes, offers approve over review, and refuses a plain approve", async () => {
    const project = await atGate();
    const view = projectGateView({ sessionId: "s1", project, estimate: null, selectable: { workers: [], reviewers: [] } });
    expect(view.hints).toContainEqual(expect.stringMatching(/^plan review 1 by cloud:model-r: 7 pass, 0 warn, 1 fail; open notes/));
    expect(view.hints).toContainEqual(expect.stringMatching(/^plan review: criteria-coverage: fail: No task check names approved criteria: c2/));
    expect(view.planReview).toMatchObject({ outcome: "reviewed", stale: false, round: 1, results: expect.arrayContaining([expect.objectContaining({ dimension: "criteria-coverage", verdict: "fail" })]) });
    expect(view.allowedVerdicts).toContain("approveOverReview");
    const plain = decide(project, "approve");
    expect(plain.ok).toBe(false);
    expect(!plain.ok && plain.error).toMatchObject({ code: "review-open", message: expect.stringMatching(/plan reviewer/), blocks: [expect.objectContaining({ taskId: "plan" })] });
  });

  it("the person approves over the open notes with a note, recorded on the plan", async () => {
    const project = await atGate();
    expect(decide(project, "approveOverReview").ok).toBe(false);
    const over = decide(project, "approveOverReview", "c2 is covered by hand testing");
    if (!over.ok) throw new Error(over.error.message);
    expect(over.project.plan).toMatchObject({
      status: "approved",
      reviewOverride: { note: "c2 is covered by hand testing", at: NOW + 1, blocks: [expect.objectContaining({ reason: expect.stringContaining("criteria-coverage") })] },
    });
    expect(over.project.milestones[0]?.state).toBe("approved");
  });

  it("a deterministic plan-check fail stays hard even over the review", async () => {
    // `echo` only: a severe check-lint finding, a deterministic fail.
    const project = await atGate({ ...uncoveredPlan, tasks: [{ ...uncoveredPlan.tasks[0]!, checks: [{ cmd: "echo ok", criteria: ["c1"] }] }] });
    expect(project.plan?.checkResults?.some((r) => r.dimension === "check-lint" && r.verdict === "fail")).toBe(true);
    const over = decide(project, "approveOverReview", "fine");
    expect(!over.ok && over.error.code).toBe("review-open");
  });

  it("a review the rows no longer match is shown stale and does not block", async () => {
    const project = await atGate();
    const edited: ProjectState = { ...project, plan: { ...project.plan!, rows: project.plan!.rows.map((r) => ({ ...r, worker: "local:other" })) } };
    const view = projectGateView({ sessionId: "s1", project: edited, estimate: null, selectable: { workers: [], reviewers: [] } });
    expect(view.hints).toContainEqual(expect.stringMatching(/plan review is stale/));
    expect(view.planReview).toMatchObject({ stale: true });
    expect(view.allowedVerdicts).not.toContain("approveOverReview");
    expect(decide(edited, "approve").ok).toBe(true);
  });

  it("auto-approval stops at a plan with open reviewer fails and never overrides", async () => {
    let project = await atGate();
    const decisions: string[] = [];
    const rt = {
      projectState: () => projectGateView({ sessionId: "s1", project, estimate: null, selectable: { workers: [], reviewers: [] } }),
      projectDecision: (_id: string, decision: Parameters<typeof applyProjectDecision>[1]) => {
        decisions.push(decision.verdict);
        const r = applyProjectDecision(project, decision, { now: NOW + 1 });
        if (!r.ok) return r;
        project = r.project;
        return { ok: true as const, project: r.project, view: rt.projectState() };
      },
    };
    const step = await settleProjectGate(rt, "s1", "approve");
    expect(step.kind).toBe("stop");
    expect(step.kind === "stop" && step.text).toMatch(/plan reviewer's open notes/);
    expect(decisions).toEqual([]);
    expect(project.plan?.status).toBe("draft");
  });
});

describe("plan review facts are recomputed, never stored (review round, issue #118)", () => {
  it("deferring the uncited decision at the gate lets the plan be approved; the record keeps only the model's verdicts", async () => {
    const p0 = applyProjectUpdate(undefined, { kind: "brief", brief: { what: "Snake", users: "Kids", how: "One page", successCriteria: [{ id: "c1", text: "Runs" }], decisions: [{ id: "d1", text: "Use canvas" }] }, draftedAfterUntrusted: false }, NOW);
    if (!p0.ok) throw new Error(p0.error.message);
    const a = applyProjectDecision(p0.project, { gate: p0.project.gate, version: gateVersion(p0.project)!, verdict: "approve" }, { now: NOW });
    if (!a.ok) throw new Error(a.error.message);
    const complete = vi.fn(async () => ({ content: passAll() }));
    const plan = { milestones: [{ id: "m1", title: "Build", kind: "base" }], tasks: [{ id: "t1", title: "Build in `game.js`", milestone: "m1", checks: [check(["c1"])] }] };
    const { project } = await draft(a.project, plan, { planReview: createPlanReview(reviewDeps(complete)), planReviewRounds: () => 0 });
    expect(project.plan?.review?.results.find((r) => r.dimension === "decisions")?.verdict).toBe("pass");
    const deferred = applyProjectDecision(project, { gate: project.gate, version: gateVersion(project)!, verdict: "edit", edits: { decisionStatus: { d1: "deferred" } } }, { now: NOW + 1 });
    if (!deferred.ok) throw new Error(deferred.error.message);
    const approved = applyProjectDecision(deferred.project, { gate: deferred.project.gate, version: gateVersion(deferred.project)!, verdict: "approve" }, { now: NOW + 2 });
    expect(approved.ok).toBe(true);
  });
});

describe("a plan that was not reviewed (review round, issue #118)", () => {
  const rt = (state: { project: ProjectState }) => ({
    projectState: () => projectGateView({ sessionId: "s1", project: state.project, estimate: null, selectable: { workers: [], reviewers: [] }, planReviewerConfigured: true }),
    projectDecision: (_id: string, decision: Parameters<typeof applyProjectDecision>[1]) => {
      const r = applyProjectDecision(state.project, decision, { now: NOW + 1 });
      if (!r.ok) return r;
      state.project = r.project;
      return { ok: true as const, project: r.project, view: rt(state).projectState() };
    },
  });

  it("retries a malformed answer once", async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce({ content: "sure, looks fine", usage: { promptTokens: 1000, completionTokens: 10, totalTokens: 1010 } })
      .mockResolvedValueOnce({ content: passAll(), usage: { promptTokens: 1000, completionTokens: 100, totalTokens: 1100 } });
    const { update } = await draft(approvedBrief(), coveredPlan, { planReview: createPlanReview(reviewDeps(complete as never)) });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(String((complete.mock.calls[1] as unknown as [{ prompt: string }])[0].prompt)).toMatch(/previous answer could not be read/);
    expect(update.planReview).toMatchObject({ outcome: "reviewed" });
    expect(update.planReview?.costUsd).toBeCloseTo(((2000 + 2 * 110) / 1e6), 6);
  });

  it("a review that did not run says the plan was not reviewed; automation stops, the person may approve", async () => {
    const complete = vi.fn(async () => ({ content: JSON.stringify({ results: [] }) }));
    const state = { project: (await draft(approvedBrief(), coveredPlan, { planReview: createPlanReview(reviewDeps(complete)) })).project };
    expect(complete).toHaveBeenCalledTimes(2);
    const view = rt(state).projectState();
    expect(view.hints).toContainEqual(expect.stringMatching(/^plan not reviewed: the reviewer's answer could not be read/));
    expect(view.planReview).toMatchObject({ outcome: "not-run", autoApprovable: false });
    const step = await settleProjectGate(rt(state), "s1", "approve");
    expect(step.kind).toBe("stop");
    expect(step.kind === "stop" && step.text).toMatch(/not reviewed/);
    expect(state.project.plan?.status).toBe("draft");
    expect(applyProjectDecision(state.project, { gate: state.project.gate, version: gateVersion(state.project)!, verdict: "approve" }, { now: NOW + 2 }).ok).toBe(true);
  });

  it("a call refused before an answer (the budget) is not retried and stops automation", async () => {
    const complete = vi.fn(async () => { throw new Error("the spend cap for this turn is reached"); });
    const state = { project: (await draft(approvedBrief(), coveredPlan, { planReview: createPlanReview(reviewDeps(complete as never)) })).project };
    expect(complete).toHaveBeenCalledTimes(1);
    expect(rt(state).projectState().hints).toContainEqual(expect.stringMatching(/^plan not reviewed: the reviewer could not run: the spend cap/));
    expect((await settleProjectGate(rt(state), "s1", "approve")).kind).toBe("stop");
  });

  it("a review that passes lets automation approve", async () => {
    const complete = vi.fn(async () => ({ content: passAll() }));
    const state = { project: (await draft(approvedBrief(), coveredPlan, { planReview: createPlanReview(reviewDeps(complete)) })).project };
    expect(rt(state).projectState().planReview).toMatchObject({ autoApprovable: true });
    expect((await settleProjectGate(rt(state), "s1", "approve")).kind).toBe("approved");
  });
});

describe("a plan with no review recorded (review round, issue #118)", () => {
  const viewOf = (project: ProjectState, configured: boolean) =>
    projectGateView({ sessionId: "s1", project, estimate: null, selectable: { workers: [], reviewers: [] }, planReviewerConfigured: configured });
  const runtimeOf = (state: { project: ProjectState }) => ({
    projectState: () => viewOf(state.project, true),
    projectDecision: (_id: string, decision: Parameters<typeof applyProjectDecision>[1]) => {
      const r = applyProjectDecision(state.project, decision, { now: NOW + 1 });
      if (!r.ok) return r;
      state.project = r.project;
      return { ok: true as const, project: r.project, view: viewOf(r.project, true) };
    },
  });

  it("an outside edit of a held draft opens the gate as not reviewed; automation stops, the person may approve", async () => {
    const complete = vi.fn(async () => ({ content: passAll({ scope: { verdict: "fail", detail: "drops the level editor" } }) }));
    const held = (await draft(approvedBrief(), coveredPlan, { planReview: createPlanReview(reviewDeps(complete)) })).project;
    expect(held.gate).toEqual({ kind: "none" });
    const file: ProjectState = { ...held, plan: { ...held.plan!, rows: held.plan!.rows.map((r) => ({ ...r, title: `${r.title} (edited)` })) } };
    const record = { version: 1, folder: "/p", id: "p1", seq: 1, state: held, decisions: [] } as ProjectRecord;
    const state = { project: resolveProject(file, record, NOW + 5) };
    expect(state.project.gate).toEqual({ kind: "plan" });
    const view = viewOf(state.project, true);
    expect(view.hints).toContainEqual(expect.stringMatching(/^plan not reviewed: no review is recorded for this plan/));
    expect(view.planReview).toMatchObject({ outcome: "missing", autoApprovable: false });
    expect((await settleProjectGate(runtimeOf(state), "s1", "approve")).kind).toBe("stop");
    expect(applyProjectDecision(state.project, { gate: state.project.gate, version: gateVersion(state.project)!, verdict: "approve" }, { now: NOW + 6 }).ok).toBe(true);
  });

  it("a project opened from its content alone (another machine) is not reviewed either", async () => {
    const complete = vi.fn(async () => ({ content: passAll() }));
    const reviewed = (await draft(approvedBrief(), coveredPlan, { planReview: createPlanReview(reviewDeps(complete)) })).project;
    const fresh = freshFromContent(reviewed);
    expect(fresh.plan?.review).toBeUndefined();
    // The brief gate first: approve it, the plan draft then waits for the director, not the person.
    expect(viewOf({ ...fresh, gate: { kind: "plan" } }, true).planReview).toMatchObject({ outcome: "missing", autoApprovable: false });
  });

  it("without a plan reviewer configured an unreviewed plan says nothing (unchanged)", async () => {
    const { project } = await draft(approvedBrief(), coveredPlan, {});
    const view = viewOf(project, false);
    expect(view.planReview).toBeUndefined();
    expect(view.hints.some((h) => /plan review|not reviewed/.test(h))).toBe(false);
  });
});

describe("a review the person's own edit made stale (review round, issue #118)", () => {
  it("keeps the earlier notes visible, lets the person approve, and stops automation", async () => {
    const complete = vi.fn(async () => ({ content: passAll({ scope: { verdict: "fail", detail: "drops the level editor" } }) }));
    const atGate = (await draft(approvedBrief(), coveredPlan, { planReview: createPlanReview(reviewDeps(complete)), planReviewRounds: () => 0 })).project;
    const cheaper = applyProjectDecision(atGate, { gate: atGate.gate, version: gateVersion(atGate)!, verdict: "cheaper" }, { now: NOW + 1, replan: (rows) => rows.map((r) => ({ ...r, worker: "local:other" })) });
    if (!cheaper.ok) throw new Error(cheaper.error.message);
    const state = { project: cheaper.project };
    const viewOf = () => projectGateView({ sessionId: "s1", project: state.project, estimate: null, selectable: { workers: [], reviewers: [] }, planReviewerConfigured: true });
    const view = viewOf();
    expect(view.hints).toContainEqual(expect.stringMatching(/plan review is stale/));
    expect(view.hints).toContainEqual("notes on an earlier version: plan review: scope: fail: drops the level editor");
    expect(view.planReview).toMatchObject({ stale: true, autoApprovable: false });
    const rt = {
      projectState: viewOf,
      projectDecision: (_id: string, d: Parameters<typeof applyProjectDecision>[1]) => {
        const r = applyProjectDecision(state.project, d, { now: NOW + 2 });
        return r.ok ? { ok: true as const, project: r.project, view: viewOf() } : r;
      },
    };
    expect((await settleProjectGate(rt, "s1", "approve")).kind).toBe("stop");
    expect(applyProjectDecision(state.project, { gate: state.project.gate, version: gateVersion(state.project)!, verdict: "approve" }, { now: NOW + 3 }).ok).toBe(true);
  });
});

describe("plan review rounds per plan cycle (review round, issue #118)", () => {
  it("the director cannot restart the rounds by drafting again; a person's decision starts a new cycle", async () => {
    const complete = vi.fn(async () => ({ content: passAll({ scope: { verdict: "fail", detail: "drops the level editor" } }) }));
    const deps = { planReview: createPlanReview(reviewDeps(complete)), planReviewRounds: () => 1 };
    let project = (await draft(approvedBrief(), coveredPlan, deps)).project;
    expect(project.gate).toEqual({ kind: "none" });
    project = (await draft(project, coveredPlan, deps)).project;
    expect(project.gate).toEqual({ kind: "plan" });
    project = (await draft(project, coveredPlan, deps)).project;
    expect(project.gate).toEqual({ kind: "plan" });
    expect(project.plan?.review).toMatchObject({ round: 3, sentBack: false });
    // The person corrects a row: their decision; the director's next draft is a new cycle.
    const edited = applyProjectDecision(project, { gate: project.gate, version: gateVersion(project)!, verdict: "edit", edits: { rows: [{ taskId: "t1", reviewer: null }] } }, { now: NOW + 1 });
    if (!edited.ok) throw new Error(edited.error.message);
    const next = (await draft(edited.project, coveredPlan, deps)).project;
    expect(next.plan?.review).toMatchObject({ round: 1, sentBack: true });
  });
});
