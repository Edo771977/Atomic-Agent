import { describe, expect, it, vi } from "vitest";

import { parseTeamMember, type TeamMember } from "../../llm/run-mode/fusion-team.js";
import type { ProjectState, ProjectUpdate } from "../../session/session-project.js";
import type { ToolContext } from "../tool-registry.js";
import type { OutcomeRecord } from "./outcome-log.js";
import { PRESET_REASON } from "./project-estimate.js";
import {
  PROJECT_BRIEF_TOOL,
  PROJECT_MILESTONE_TOOL,
  PROJECT_PLAN_TOOL,
  PROJECT_TOOL_NAMES,
  PROJECT_UPDATE_DETAIL,
  buildProjectTools,
  parseProjectBriefArgs,
  parseProjectMilestoneArgs,
  parseProjectPlanArgs,
  type ProjectPlanContext,
  type ProjectToolDeps,
} from "./project-tools.js";

const ctx = { workingDir: "/tmp", sessionId: "s1", stepIndex: 0 } as unknown as ToolContext;
const NOW = Date.parse("2026-11-01T00:00:00Z");

const m = (ref: string): TeamMember => parseTeamMember(ref)!;
const local = m("local:model-a");
const cloud = m("cloud:model-b");
const reviewer = m("cloud:model-r");

function taskRow(provider: string, model: string, costUsd: number, durationMs: number): OutcomeRecord {
  return {
    v: 1,
    type: "task",
    ts: new Date(NOW - 3_600_000).toISOString(),
    provider,
    model,
    role: null,
    taskRole: null,
    durationMs,
    costUsd,
  } as unknown as OutcomeRecord;
}

function planContext(extra: Partial<ProjectPlanContext> = {}): ProjectPlanContext {
  return {
    workers: [local, cloud],
    reviewers: [reviewer],
    defaultWorker: local,
    reviewerFor: (w) => (w.ref === reviewer.ref ? null : reviewer),
    reviewOn: true,
    records: [taskRow("cloud", "model-b", 0.2, 4000), taskRow("cloud", "model-b", 0.4, 6000)],
    pricing: (member) => (member.providerId === "cloud" ? { input: 1, output: 2 } : undefined),
    tokensPerSecond: (member) => (member.providerId === "local" ? 20 : null),
    minSamples: 2,
    days: 30,
    now: NOW,
    ...extra,
  };
}

function tools(options: { tainted?: boolean; context?: ProjectPlanContext; evidence?: ProjectToolDeps["milestoneEvidence"] } = {}) {
  const [brief, plan, milestone] = buildProjectTools({
    planContext: () => options.context ?? planContext(),
    outsideContent: () => options.tainted === true,
    ...(options.evidence === undefined ? {} : { milestoneEvidence: options.evidence }),
  });
  return { brief: brief!, plan: plan!, milestone: milestone! };
}

const briefArgs = {
  what: "A snake game",
  users: "Kids",
  how: "One HTML page",
  successCriteria: ["Runs offline", "Arrow keys steer"],
};

describe("project tools: definitions", () => {
  it("are read-only, named and in catalog order", () => {
    const t = tools();
    expect([t.brief.name, t.plan.name, t.milestone.name]).toEqual([...PROJECT_TOOL_NAMES]);
    expect(PROJECT_TOOL_NAMES).toEqual([PROJECT_BRIEF_TOOL, PROJECT_PLAN_TOOL, PROJECT_MILESTONE_TOOL]);
    for (const tool of [t.brief, t.plan, t.milestone]) {
      expect(tool.readonly).toBe(true);
      expect(tool.untrustedOutput).toBeUndefined();
    }
  });
});

describe("project.brief", () => {
  it("hands a brief update back in details and tells the director to reply", async () => {
    const result = await tools().brief.run(briefArgs, ctx);
    expect(result.status).toBe("ok");
    const update = result.details[PROJECT_UPDATE_DETAIL] as ProjectUpdate;
    expect(update).toEqual({ kind: "brief", brief: briefArgs, draftedAfterUntrusted: false });
    expect(result.summary).toMatch(/reply/i);
  });

  it("marks a draft written after outside content", async () => {
    const result = await tools({ tainted: true }).brief.run(briefArgs, ctx);
    expect((result.details[PROJECT_UPDATE_DETAIL] as { draftedAfterUntrusted: boolean }).draftedAfterUntrusted).toBe(true);
  });

  it("refuses malformed args with every problem named", async () => {
    expect(parseProjectBriefArgs({ what: "", users: 1, successCriteria: "x" })).toMatchObject({ ok: false });
    const result = await tools().brief.run({ what: 3 }, ctx);
    expect(result.status).toBe("error");
    expect(result.summary).toMatch(/what/);
    expect(result.summary).toMatch(/successCriteria/);
    expect(result.details[PROJECT_UPDATE_DETAIL]).toBeUndefined();
  });

  it("takes criteria as text or { id, text }; refuses a bad or repeated id", () => {
    const successCriteria = ["Runs offline", { id: "keys", text: "Arrow keys steer" }];
    expect(parseProjectBriefArgs({ ...briefArgs, successCriteria })).toMatchObject({ ok: true, brief: { successCriteria } });
    for (const bad of [[{ id: "Not ok", text: "x" }], [{ id: "a", text: "x" }, { id: "a", text: "y" }], [{ id: "a" }], [{ text: " " }], ["x".repeat(3), 4]]) {
      const parsed = parseProjectBriefArgs({ ...briefArgs, successCriteria: bad });
      expect(parsed).toMatchObject({ ok: false });
      expect(JSON.stringify(parsed)).toMatch(/successCriteria/);
    }
  });

  it("accepts the optional game block and refuses a partial one", () => {
    const game = { rules: "eat apples", loop: "move, eat, grow", difficulty: "speeds up", style: "pixel" };
    expect(parseProjectBriefArgs({ ...briefArgs, game })).toMatchObject({ ok: true, brief: { game } });
    expect(parseProjectBriefArgs({ ...briefArgs, game: { rules: "x" } })).toMatchObject({ ok: false });
  });
});

describe("project.plan", () => {
  const planArgs = {
    milestones: [
      { id: "base", title: "Board and snake", kind: "base" },
      { id: "ui", title: "Score and menus", kind: "ui" },
    ],
    tasks: [
      { id: "board", title: "Draw the board", milestone: "base" },
      { id: "score", title: "Score panel", milestone: "ui", worker: "cloud:model-b" },
    ],
  };

  it("enriches every task with worker, reviewer and estimate, and picks the detail", async () => {
    const result = await tools().plan.run(planArgs, ctx);
    expect(result.status).toBe("ok");
    const update = result.details[PROJECT_UPDATE_DETAIL] as Extract<ProjectUpdate, { kind: "plan" }>;
    expect(update.kind).toBe("plan");
    expect(update.milestones).toEqual(planArgs.milestones);
    expect(update.detail).toBe("compact");
    const [board, score] = update.rows;
    // Default worker, no history: preset; local speed gives a time, no price.
    expect(board).toMatchObject({
      taskId: "board",
      milestoneId: "base",
      worker: "local:model-a",
      reviewer: "cloud:model-r",
      basis: "preset",
      samples: 0,
      estCostUsd: null,
    });
    expect(board!.reason).toContain(PRESET_REASON);
    expect(board!.estMs).toBeGreaterThan(0);
    // Named worker with two priced runs: measured medians.
    expect(score).toMatchObject({ worker: "cloud:model-b", basis: "measured", samples: 2, estCostUsd: 0.3, estMs: 5000 });
    expect(result.summary).toContain("board");
    expect(result.summary).toMatch(/reply/i);
  });

  it("marks a plan drafted after outside content", async () => {
    const clean = await tools().plan.run(planArgs, ctx);
    expect((clean.details[PROJECT_UPDATE_DETAIL] as { draftedAfterUntrusted?: boolean }).draftedAfterUntrusted).toBe(false);
    const tainted = await tools({ tainted: true }).plan.run(planArgs, ctx);
    expect((tainted.details[PROJECT_UPDATE_DETAIL] as { draftedAfterUntrusted?: boolean }).draftedAfterUntrusted).toBe(true);
  });

  it("names a worker by model alone and takes the director's reviewer, or none", async () => {
    const result = await tools().plan.run({
      ...planArgs,
      tasks: [
        { id: "board", title: "Board", milestone: "base", worker: "model-b", reviewer: "cloud:model-r" },
        { id: "score", title: "Score", milestone: "ui", reviewer: null },
      ],
    }, ctx);
    const rows = (result.details[PROJECT_UPDATE_DETAIL] as Extract<ProjectUpdate, { kind: "plan" }>).rows;
    expect(rows[0]).toMatchObject({ worker: "cloud:model-b", reviewer: "cloud:model-r" });
    expect(rows[1]).toMatchObject({ worker: "local:model-a", reviewer: null });
  });

  it("no reviews when the team review is off", async () => {
    const result = await tools({ context: planContext({ reviewOn: false }) }).plan.run(planArgs, ctx);
    const rows = (result.details[PROJECT_UPDATE_DETAIL] as Extract<ProjectUpdate, { kind: "plan" }>).rows;
    expect(rows.map((r) => r.reviewer)).toEqual([null, null]);
  });

  it("full detail above the task threshold", async () => {
    const tasks = Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, title: `T${i}`, milestone: "base" }));
    const result = await tools().plan.run({ ...planArgs, tasks }, ctx);
    expect((result.details[PROJECT_UPDATE_DETAIL] as { detail: string }).detail).toBe("full");
  });

  it("refuses an unknown worker or reviewer, a task on an unknown milestone, and duplicate ids", async () => {
    const shape = await tools().plan.run({
      ...planArgs,
      tasks: [
        { id: "a", title: "A", milestone: "base" },
        { id: "a", title: "A2", milestone: "nowhere" },
      ],
    }, ctx);
    expect(shape.status).toBe("error");
    expect(shape.summary).toMatch(/nowhere/);
    expect(shape.summary).toMatch(/twice/);
    const members = await tools().plan.run({
      ...planArgs,
      tasks: [
        { id: "a", title: "A", milestone: "base", worker: "nobody:x" },
        { id: "b", title: "B", milestone: "base", reviewer: "nobody:y" },
      ],
    }, ctx);
    expect(members.status).toBe("error");
    expect(members.summary).toMatch(/nobody:x/);
    expect(members.summary).toMatch(/nobody:y/);
    expect(parseProjectPlanArgs({ milestones: [], tasks: [] })).toMatchObject({ ok: false });
    expect(parseProjectPlanArgs({ milestones: [{ id: "x", title: "X", kind: "weird" }], tasks: [{ id: "t", title: "T", milestone: "x" }] }))
      .toMatchObject({ ok: false });
  });

  it("with no worker to give a task, refuses", async () => {
    const result = await tools({ context: planContext({ workers: [], defaultWorker: null }) }).plan.run(planArgs, ctx);
    expect(result.status).toBe("error");
    expect(result.summary).toMatch(/worker/);
  });
});

describe("project.milestone", () => {
  it("hands the report back", async () => {
    const result = await tools().milestone.run({ id: "base", state: "done", summary: "Board drawn, snake moves" }, ctx);
    expect(result.status).toBe("ok");
    expect(result.details[PROJECT_UPDATE_DETAIL]).toEqual({ kind: "milestone", id: "base", state: "done", summary: "Board drawn, snake moves" });
    expect(result.summary).toMatch(/reply/i);
  });

  it("passes attachments through for the fold to check against the milestone's runs (issue #40)", async () => {
    const attachments = [{ path: "/state/fusion-runs/r1/shots/t1-1.jpg", caption: "The board", criteria: ["c1"] }];
    const result = await tools().milestone.run({ id: "base", state: "done", summary: "Board drawn", attachments }, ctx);
    expect(result.details[PROJECT_UPDATE_DETAIL]).toEqual({ kind: "milestone", id: "base", state: "done", summary: "Board drawn", attachments });
    for (const bad of [[{ path: "/a.jpg" }], "x", [{ path: 3, caption: "c" }], [{ path: "/a.jpg", caption: "c", criteria: "c1" }], Array.from({ length: 9 }, () => ({ path: "/a.jpg", caption: "c" }))]) {
      expect(parseProjectMilestoneArgs({ id: "base", state: "done", summary: "x", attachments: bad })).toMatchObject({ ok: false });
    }
  });

  it("a done report carries its runs' criteria facts and, when it names none, their screenshots (issue #40)", async () => {
    const shots = [{ path: "/state/fusion-runs/r1/shots/board-2.jpg", caption: "board: screenshot 2", criteria: ["c1"] }];
    const evidence = vi.fn<NonNullable<ProjectToolDeps["milestoneEvidence"]>>(() => ({
      facts: [{ id: "c1", state: "passed", why: "every check naming it passed" }],
      attachments: shots,
      uncovered: ["c2"],
    }));
    const project = { milestones: [{ id: "base", runIds: ["r1"] }], brief: { successCriteria: [{ id: "c1", text: "Runs offline" }, { id: "c2", text: "Arrow keys steer" }] } } as unknown as ProjectState;
    const result = await tools({ evidence }).milestone.run({ id: "base", state: "done", summary: "Board drawn" }, { ...ctx, project });
    expect(evidence).toHaveBeenCalledWith(expect.objectContaining({ id: "base", runIds: ["r1"] }), ["c1", "c2"]);
    expect(result.details[PROJECT_UPDATE_DETAIL]).toEqual({
      kind: "milestone", id: "base", state: "done", summary: "Board drawn\nWarning: not covered by a check: c2.",
      criteriaFacts: [{ id: "c1", state: "passed", why: "every check naming it passed" }], attachments: shots,
    });
    expect(result.summary).toContain("c1 passed");
    expect(result.summary).toContain("not covered by a check: c2");
    // Named attachments win; a failed report carries no facts.
    const named = [{ path: "/state/fusion-runs/r1/shots/board-1.jpg", caption: "mine" }];
    const own = await tools({ evidence }).milestone.run({ id: "base", state: "done", summary: "x", attachments: named }, { ...ctx, project });
    expect((own.details[PROJECT_UPDATE_DETAIL] as { attachments: unknown }).attachments).toEqual(named);
    const failed = await tools({ evidence }).milestone.run({ id: "base", state: "failed", summary: "x" }, { ...ctx, project });
    expect(failed.details[PROJECT_UPDATE_DETAIL]).not.toHaveProperty("criteriaFacts");
    // The model cannot pass facts itself.
    expect(parseProjectMilestoneArgs({ id: "base", state: "done", summary: "x", criteriaFacts: [] })).toMatchObject({ ok: false });
  });

  it("refuses a done report while a criterion its checks name is failed or unverified (issue #40)", async () => {
    const project = { milestones: [{ id: "base", runIds: ["r1"] }], brief: { successCriteria: [{ id: "c1", text: "Runs offline" }, { id: "c2", text: "Looks right" }] } } as unknown as ProjectState;
    for (const state of ["failed", "unverified"] as const) {
      const evidence = () => ({ facts: [{ id: "c1", state: "passed" as const }, { id: "c2", state, why: "no vision judge" }], attachments: [], uncovered: [] });
      const result = await tools({ evidence }).milestone.run({ id: "base", state: "done", summary: "Board drawn" }, { ...ctx, project });
      expect(result.status).toBe("error");
      expect(result.summary).toContain(`c2 ${state}`);
      expect(result.summary).toMatch(/Fix it and re-delegate, or report "failed" with the reasons/);
      expect(result.details[PROJECT_UPDATE_DETAIL]).toBeUndefined();
    }
    const evidence = () => ({ facts: [{ id: "c2", state: "failed" as const }], attachments: [], uncovered: [] });
    const failed = await tools({ evidence }).milestone.run({ id: "base", state: "failed", summary: "c2 does not render" }, { ...ctx, project });
    expect(failed.status).toBe("ok");
  });

  it("the model cannot approve or review", async () => {
    expect(parseProjectMilestoneArgs({ id: "base", state: "reviewed", summary: "x" })).toMatchObject({ ok: false });
    expect(parseProjectMilestoneArgs({ id: "base", state: "approved", summary: "x" })).toMatchObject({ ok: false });
    expect(parseProjectMilestoneArgs({ id: "base", state: "done" })).toMatchObject({ ok: false });
  });
});
