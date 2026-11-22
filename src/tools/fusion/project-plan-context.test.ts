import { describe, expect, it } from "vitest";

import type { FusionTeamContext } from "./team-routing.js";
import { PROJECT_ESTIMATE_MIN_SAMPLES, projectPlanContextFrom } from "./project-plan-context.js";
import { PROJECT_UPDATE_DETAIL, buildProjectTools } from "./project-tools.js";
import type { ProjectUpdate } from "../../session/session-project.js";
import type { ToolContext } from "../tool-registry.js";

const team: FusionTeamContext = {
  team: { directors: ["cloud:model-d"], workers: ["local:model-a", "cloud:model-b", "banned:model-c"], reviewers: ["cloud:model-r"] },
  fusion: { workerProvider: "local", workerModel: "model-a" },
  familyOf: (m) => (m.providerId === "local" ? "local" : "other"),
  reachable: () => true,
  pinsModel: (p) => p !== "local",
};

const base = {
  allows: (p: string) => p !== "banned",
  workerLeg: { providerId: "local", model: "model-a" },
  records: [],
  pricing: (p: string) => (p === "cloud" ? { input: 1, output: 1 } : undefined),
  isLocal: (p: string) => p === "local",
  tokensPerSecond: () => 12,
};

describe("projectPlanContextFrom", () => {
  it("binds the team's workers and reviewers under the folder policy", () => {
    const ctx = projectPlanContextFrom({ ...base, team });
    expect(ctx.workers.map((m) => m.ref)).toEqual(["local:model-a", "cloud:model-b"]);
    expect(ctx.defaultWorker?.ref).toBe("local:model-a");
    expect(ctx.reviewers.map((m) => m.ref)).toEqual(["cloud:model-r"]);
    expect(ctx.reviewOn).toBe(true);
    expect(ctx.reviewerFor(ctx.workers[0]!)?.ref).toBe("cloud:model-r");
    expect(ctx.tokensPerSecond(ctx.workers[0]!)).toBe(12);
    expect(ctx.tokensPerSecond(ctx.workers[1]!)).toBeNull();
    expect(ctx.pricing(ctx.workers[1]!)).toEqual({ input: 1, output: 1 });
    expect(ctx.minSamples).toBe(PROJECT_ESTIMATE_MIN_SAMPLES);
  });

  it("the session's chosen worker is the default", () => {
    const ctx = projectPlanContextFrom({ ...base, team, currentWorker: { providerId: "cloud", model: "model-b", ref: "cloud:model-b" } });
    expect(ctx.defaultWorker?.ref).toBe("cloud:model-b");
  });

  it("the chat's reviewer is the rows' default reviewer; \"none\" turns review off (issue #71)", () => {
    const two = { ...team, team: { ...team.team, reviewers: ["cloud:model-r", "cloud:model-q"] } };
    const chosen = projectPlanContextFrom({ ...base, team: two, currentReviewer: { providerId: "cloud", model: "model-q", ref: "cloud:model-q" } });
    expect(chosen.reviewerFor(chosen.workers[0]!)?.ref).toBe("cloud:model-q");
    const none = projectPlanContextFrom({ ...base, team: two, currentReviewer: "none" });
    expect(none.reviewOn).toBe(false);
    // The person can still pick a reviewer per row from the list.
    expect(none.reviewers.map((m) => m.ref)).toEqual(["cloud:model-r", "cloud:model-q"]);
  });

  it("leaves out a reviewer whose CLI tools stay on in a restricted chat (issue #71)", () => {
    const ctx = projectPlanContextFrom({ ...base, team, restricted: true, cliToolsStayOn: (p) => p === "cloud" });
    expect(ctx.reviewers).toEqual([]);
    expect(ctx.reviewOn).toBe(false);
  });

  it("without a team the worker leg is the only worker and there is no per-task reviewer", () => {
    const ctx = projectPlanContextFrom({ ...base, team: undefined, measured: { minSamples: 3, days: 7 } });
    expect(ctx.workers.map((m) => m.ref)).toEqual(["local:model-a"]);
    expect(ctx.defaultWorker?.ref).toBe("local:model-a");
    expect(ctx.reviewOn).toBe(false);
    expect([ctx.minSamples, ctx.days]).toEqual([3, 7]);
    expect(projectPlanContextFrom({ ...base, team: undefined, workerLeg: null }).defaultWorker).toBeNull();
  });
});

describe("a reviewer the plan names while review is off for the run", () => {
  // The live shape: directors and reviewers listed, `team.review: "off"`, no workers.
  const reviewOffTeam: FusionTeamContext = {
    ...team,
    team: { directors: ["codex-cli:default"], reviewers: ["claude-cli:default", "codex-cli:default", "cloud:model-r"], review: "off" },
  };
  const leg = { ...base, allows: () => true, workerLeg: { providerId: "claude-cli", model: "default" } };
  const planArgs = (reviewer: string | null | undefined) => ({
    milestones: [{ id: "m1", title: "Write", kind: "base" }],
    tasks: [{ id: "scrivi-report", title: "Write the report", milestone: "m1", ...(reviewer === undefined ? {} : { reviewer }) }],
  });
  async function run(ctx: ReturnType<typeof projectPlanContextFrom>, reviewer: string | null | undefined) {
    const [, plan] = buildProjectTools({ planContext: () => ctx, outsideContent: () => false });
    const result = await plan!.run(planArgs(reviewer), { workingDir: "/tmp/proj", sessionId: "s1", stepIndex: 0, signal: new AbortController().signal } as unknown as ToolContext);
    return { result, update: result.details[PROJECT_UPDATE_DETAIL] as Extract<ProjectUpdate, { kind: "plan" }> };
  }

  it("says why review is off: team.review, the chat's none, or no reviewer this folder can use", () => {
    const off = projectPlanContextFrom({ ...leg, team: reviewOffTeam });
    expect(off.reviewOn).toBe(false);
    expect(off.reviewOffReason).toBe("team.review is off");
    expect(projectPlanContextFrom({ ...leg, team, currentReviewer: "none" }).reviewOffReason).toBe("this chat chose no review");
    expect(projectPlanContextFrom({ ...leg, team, restricted: true, cliToolsStayOn: (p) => p === "cloud" }).reviewOffReason).toBe("no team reviewer this folder can use");
    expect(projectPlanContextFrom({ ...leg, team }).reviewOffReason).toBeUndefined();
  });

  it("accepts the plan with no review on the row and tells the director plainly, naming team.review", async () => {
    const { result, update } = await run(projectPlanContextFrom({ ...leg, team: reviewOffTeam }), "codex-cli");
    expect(result.status).toBe("ok");
    expect(update.rows[0]?.reviewer).toBeNull();
    expect(result.summary).toContain("task scrivi-report: review is off for this run (team.review is off), so codex-cli will not review it; do not tell the person it will.");
  });

  it("says nothing for a row that names no reviewer or null, or when review is on", async () => {
    const off = projectPlanContextFrom({ ...leg, team: reviewOffTeam });
    for (const reviewer of [undefined, null]) expect((await run(off, reviewer)).result.summary).not.toContain("review is off");
    const on = projectPlanContextFrom({ ...leg, team: { ...reviewOffTeam, team: { ...reviewOffTeam.team, review: "on" } } });
    const named = await run(on, "codex-cli");
    expect(named.update.rows[0]?.reviewer).toBe("codex-cli:default");
    expect(named.result.summary).not.toContain("review is off");
  });
});
