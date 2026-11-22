import { describe, expect, it, vi } from "vitest";

import { parseTeamMember, type TeamMember } from "../../llm/run-mode/fusion-team.js";
import { allowedProjectVerdicts, applyProjectDecision, applyProjectUpdate, gateVersion, type ProjectState, type ProjectUpdate } from "../../session/session-project.js";
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
    const spent: Array<{ costUsd: number | null; sent: boolean; local: boolean }> = [];
    const complete = vi.fn(async () => ({ content: passAll(), usage: { promptTokens: 1000, completionTokens: 100, totalTokens: 1100 } }));
    const { update } = await draft(approvedBrief(), coveredPlan, { planReview: createPlanReview(reviewDeps(complete, { onSpend: (_s, spend) => spent.push(spend) })) });
    expect(spent).toEqual([{ costUsd: expect.any(Number), sent: true, local: false }]);
    expect(spent[0]!.costUsd).toBeGreaterThan(0);
    expect(update.planReview?.costUsd).toBe(spent[0]!.costUsd);
    // A call refused before an answer came back is "not sent"; a local reviewer with no price is local.
    const refused: typeof spent = [];
    await draft(approvedBrief(), coveredPlan, { planReview: createPlanReview(reviewDeps(vi.fn(async () => { throw new Error("cap"); }) as never, { onSpend: (_s, spend) => refused.push(spend) })) });
    expect(refused).toEqual([{ costUsd: null, sent: false, local: false }]);
    const local: typeof spent = [];
    await draft(approvedBrief(), coveredPlan, { planReview: createPlanReview(reviewDeps(vi.fn(async () => ({ content: passAll() })), { pricing: () => undefined, isLocal: () => true, onSpend: (_s, spend) => local.push(spend) })) });
    expect(local).toEqual([{ costUsd: null, sent: true, local: true }]);
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
    expect(!over.ok && over.error.code).toBe("verdict-not-allowed");
    // Not offered: it could only be refused while the plan check fails.
    expect(allowedProjectVerdicts(project.gate, project)).not.toContain("approveOverReview");
    expect(!decide(project, "approve").ok).toBe(true);
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

describe("the person's override over the plan review (review round, issue #118)", () => {
  it("holds when the plan gate reopens on the same rows after a milestone's hard cap", async () => {
    const twoMilestones = {
      milestones: [{ id: "m1", title: "Build", kind: "base" }, { id: "m2", title: "Polish", kind: "polish" }],
      tasks: [
        { id: "t1", title: "Build the board in `game.js`", milestone: "m1", checks: [check(["c1"])] },
        { id: "t2", title: "Keys in `game.js`", milestone: "m2", checks: [check(["c2"])] },
      ],
    };
    const complete = vi.fn(async () => ({ content: passAll({ scope: { verdict: "fail", detail: "drops the level editor" } }) }));
    const atGate = (await draft(approvedBrief(), twoMilestones, { planReview: createPlanReview(reviewDeps(complete)), planReviewRounds: () => 0 })).project;
    const over = applyProjectDecision(atGate, { gate: atGate.gate, version: gateVersion(atGate)!, verdict: "approveOverReview", edits: { note: "the editor comes later" } }, { now: NOW + 1 });
    if (!over.ok) throw new Error(over.error.message);
    let p = over.project;
    for (const u of [{ kind: "milestone_run", id: "m1", runId: "r1" }, { kind: "milestone", id: "m1", state: "done", summary: "built" }] as ProjectUpdate[]) {
      const r = applyProjectUpdate(p, u, NOW + 2);
      if (!r.ok) throw new Error(r.error.message);
      p = r.project;
    }
    const capped = applyProjectDecision(p, { gate: p.gate, version: gateVersion(p)!, verdict: "approve" }, { now: NOW + 3, hardViolations: ["over today's limit"] });
    if (!capped.ok) throw new Error(capped.error.message);
    expect(capped.project.gate).toEqual({ kind: "plan" });
    expect(capped.project.plan?.reviewOverride?.note).toBe("the editor comes later");
    const again = applyProjectDecision(capped.project, { gate: capped.project.gate, version: gateVersion(capped.project)!, verdict: "approve" }, { now: NOW + 4 });
    expect(again.ok).toBe(true);
  });
});

describe("plan gate refusal wording (review round, issue #118)", () => {
  it("never doubles a period after a reason that ends a sentence", async () => {
    const p0 = applyProjectUpdate(undefined, { kind: "brief", brief: { what: "Snake", users: "Kids", how: "One page", successCriteria: [{ id: "c1", text: "Runs" }], decisions: [{ id: "d1", text: "Use canvas" }] }, draftedAfterUntrusted: false }, NOW);
    if (!p0.ok) throw new Error(p0.error.message);
    const a = applyProjectDecision(p0.project, { gate: p0.project.gate, version: gateVersion(p0.project)!, verdict: "approve" }, { now: NOW });
    if (!a.ok) throw new Error(a.error.message);
    const complete = vi.fn(async () => ({ content: passAll({ scope: { verdict: "fail", detail: "drops the level editor." } }) }));
    const plan = { milestones: [{ id: "m1", title: "Build", kind: "base" }], tasks: [{ id: "t1", title: "Build in `game.js`", milestone: "m1", checks: [check(["c1"])] }] };
    const { project } = await draft(a.project, plan, { planReview: createPlanReview(reviewDeps(complete)), planReviewRounds: () => 0 });
    const decided = applyProjectDecision(project, { gate: project.gate, version: gateVersion(project)!, verdict: "approve" }, { now: NOW + 1 });
    expect(!decided.ok && decided.error.message).toMatch(/plan gate\. Update the plan/);
    expect(!decided.ok && decided.error.message).not.toMatch(/\.\./);
    // Issue #146: a deferral at the gate now makes the review stale, so the reviewer's refusal is shown on a plan citing d1.
    const cited = { ...plan, tasks: plan.tasks.map((t) => ({ ...t, decisions: ["d1"] })) };
    const citing = (await draft(a.project, cited, { planReview: createPlanReview(reviewDeps(complete)), planReviewRounds: () => 0 })).project;
    const review = applyProjectDecision(citing, { gate: citing.gate, version: gateVersion(citing)!, verdict: "approve" }, { now: NOW + 2 });
    expect(!review.ok && review.error.message).toMatch(/drops the level editor\. Ask the director/);
    expect(!review.ok && review.error.message).not.toMatch(/\.\./);
  });
});

describe("plan reviewer at project.plan: the backlog (issue #111)", () => {
  it("is asked with the promoted and open backlog as data", async () => {
    let p = applyProjectUpdate(approvedBrief(), { kind: "backlog_add", item: { id: "b1", title: "Export PDF", source: "director", fromPerson: true } }, NOW);
    if (!p.ok) throw new Error(p.error.message);
    p = applyProjectUpdate(p.project, { kind: "backlog_add", item: { id: "b2", title: "Sounds", source: "director", condition: "when the UI exists" } }, NOW);
    if (!p.ok) throw new Error(p.error.message);
    const { applyBacklogDecision } = await import("../../session/project-backlog.js");
    const promoted = applyBacklogDecision(p.project, { id: "b1", state: "promoted" });
    if (!promoted.ok) throw new Error(promoted.error.message);
    const planReview = vi.fn(async () => null);
    await draft(promoted.project, coveredPlan, { planReview });
    expect(planReview).toHaveBeenCalledTimes(1);
    expect((planReview.mock.calls[0] as unknown as [{ input: { backlog?: unknown } }])[0].input.backlog).toEqual([
      { id: "b1", title: "Export PDF", state: "promoted" },
      { id: "b2", title: "Sounds", state: "open", condition: "when the UI exists" },
    ]);
  });

  it("is told a deferred item's state and given the backlog-coverage result as a deterministic check (issue #146)", async () => {
    let p = applyProjectUpdate(approvedBrief(), { kind: "backlog_add", item: { id: "b1", title: "Export PDF", source: "director" } }, NOW);
    if (!p.ok) throw new Error(p.error.message);
    p = applyProjectUpdate(p.project, { kind: "backlog_add", item: { id: "b2", title: "Sounds", source: "director" } }, NOW);
    if (!p.ok) throw new Error(p.error.message);
    const { applyBacklogDecision } = await import("../../session/project-backlog.js");
    let project = p.project;
    for (const id of ["b1", "b2"]) {
      const r = applyBacklogDecision(project, { id, state: "promoted" });
      if (!r.ok) throw new Error(r.error.message);
      project = r.project;
    }
    project = { ...project, backlogCalls: { ...project.backlogCalls, b2: { ...project.backlogCalls!.b2!, deferred: true } } };
    const planReview = vi.fn(async () => null);
    await draft(project, coveredPlan, { planReview });
    const input = (planReview.mock.calls[0] as unknown as [{ input: { backlog?: unknown; planChecks: Array<{ dimension: string; verdict: string; detail: string }> } }])[0].input;
    expect(input.backlog).toEqual([{ id: "b1", title: "Export PDF", state: "promoted" }, { id: "b2", title: "Sounds", state: "deferred" }]);
    expect(input.planChecks).toContainEqual(expect.objectContaining({ dimension: "backlog-coverage", verdict: "fail", detail: expect.stringContaining("b1 (Export PDF)") }));
  });
});

describe("a review the person's decision or backlog call at the gate made stale (issue #146)", () => {
  /** Brief with d1, d2 approved; b1 promoted; plan citing d1 and b1; the reviewer fails `decisions` on d2. */
  async function atGate(fail: Record<string, Partial<PlanReviewResult>>): Promise<ProjectState> {
    const p0 = applyProjectUpdate(undefined, { kind: "brief", brief: { what: "Snake", users: "Kids", how: "One page", successCriteria: [{ id: "c1", text: "Runs" }], decisions: [{ id: "d1", text: "Use canvas" }, { id: "d2", text: "No new dependencies" }] }, draftedAfterUntrusted: false }, NOW);
    if (!p0.ok) throw new Error(p0.error.message);
    const a = applyProjectDecision(p0.project, { gate: p0.project.gate, version: gateVersion(p0.project)!, verdict: "approve" }, { now: NOW });
    if (!a.ok) throw new Error(a.error.message);
    const complete = vi.fn(async () => ({ content: passAll(fail) }));
    const plan = { milestones: [{ id: "m1", title: "Build", kind: "base" }], tasks: [{ id: "t1", title: "Build in `game.js`", milestone: "m1", checks: [check(["c1"])], decisions: ["d1", "d2"] }] };
    return (await draft(a.project, plan, { planReview: createPlanReview(reviewDeps(complete)), planReviewRounds: () => 0 })).project;
  }
  const viewOf = (project: ProjectState) => projectGateView({ sessionId: "s1", project, estimate: null, selectable: { workers: [], reviewers: [] }, planReviewerConfigured: true });
  const edit = (p: ProjectState, edits: object) => {
    const r = applyProjectDecision(p, { gate: p.gate, version: gateVersion(p)!, verdict: "edit", edits: edits as never }, { now: NOW + 1 });
    if (!r.ok) throw new Error(r.error.message);
    return r.project;
  };

  it("the reviewer fails decisions on d2, the person defers d2: plain approve succeeds, notes are an earlier version's, automation stops", async () => {
    const before = await atGate({ decisions: { verdict: "fail", detail: "t1 adds a dependency, against d2" } });
    expect(applyProjectDecision(before, { gate: before.gate, version: gateVersion(before)!, verdict: "approve" }, { now: NOW + 1 })).toMatchObject({ ok: false, error: { code: "review-open" } });
    const deferred = edit(before, { decisionStatus: { d2: "deferred" } });
    const state = { project: deferred };
    const view = viewOf(deferred);
    expect(view.planReview).toMatchObject({ stale: true, autoApprovable: false });
    expect(view.hints).toContainEqual(expect.stringMatching(/^plan review is stale: the tasks or your calls on decisions or backlog items changed since review 1/));
    expect(view.hints).toContainEqual("notes on an earlier version: plan review: decisions: fail: t1 adds a dependency, against d2");
    expect(view.allowedVerdicts).not.toContain("approveOverReview");
    const rt = {
      projectState: () => viewOf(state.project),
      projectDecision: (_id: string, d: Parameters<typeof applyProjectDecision>[1]) => {
        const r = applyProjectDecision(state.project, d, { now: NOW + 2 });
        return r.ok ? { ok: true as const, project: r.project, view: viewOf(r.project) } : r;
      },
    };
    expect((await settleProjectGate(rt, "s1", "approve")).kind).toBe("stop");
    expect(applyProjectDecision(deferred, { gate: deferred.gate, version: gateVersion(deferred)!, verdict: "approve" }, { now: NOW + 3 }).ok).toBe(true);
    // Set active again, the plan reads as the review read it: the notes block again.
    const back = edit(deferred, { decisionStatus: { d2: "active" } });
    expect(viewOf(back).planReview).toMatchObject({ stale: false });
    expect(applyProjectDecision(back, { gate: back.gate, version: gateVersion(back)!, verdict: "approve" }, { now: NOW + 3 })).toMatchObject({ ok: false, error: { code: "review-open" } });
  });

  it("a backlog deferral at the gate makes the review stale the same way", async () => {
    let p = await atGate({ scope: { verdict: "fail", detail: "b1 is not delivered by t1" } });
    // b1 and b2 promoted after the review: the person defers b2 at the gate.
    for (const u of [{ kind: "backlog_add", item: { id: "b1", title: "Export PDF", source: "director" } }, { kind: "backlog_add", item: { id: "b2", title: "Sounds", source: "director" } }] as ProjectUpdate[]) {
      const r = applyProjectUpdate(p, u, NOW);
      if (!r.ok) throw new Error(r.error.message);
      p = r.project;
    }
    const { applyBacklogDecision } = await import("../../session/project-backlog.js");
    for (const id of ["b1", "b2"]) {
      const r = applyBacklogDecision(p, { id, state: "promoted" });
      if (!r.ok) throw new Error(r.error.message);
      p = r.project;
    }
    expect(viewOf(p).planReview).toMatchObject({ stale: false });
    const deferred = edit(p, { backlogStatus: { b2: "deferred" } });
    expect(viewOf(deferred).planReview).toMatchObject({ stale: true, autoApprovable: false });
    expect(viewOf(deferred).hints).toContainEqual("notes on an earlier version: plan review: scope: fail: b1 is not delivered by t1");
  });

  it("a review recorded before the person made any such call keeps its basis (older records stay fresh)", async () => {
    const p = await atGate({ scope: { verdict: "fail", detail: "drops the level editor" } });
    const { planReviewBasis } = await import("./plan-review-record.js");
    expect(p.plan?.review?.basis).toBe(planReviewBasis(p.plan!.rows, p.milestones.map((m) => m.id)));
    expect(viewOf(p).planReview).toMatchObject({ stale: false });
  });
});
