import { describe, expect, it } from "vitest";

import type { FusionTeamContext } from "./team-routing.js";
import { PROJECT_ESTIMATE_MIN_SAMPLES, projectPlanContextFrom } from "./project-plan-context.js";

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

  it("without a team the worker leg is the only worker and there is no per-task reviewer", () => {
    const ctx = projectPlanContextFrom({ ...base, team: undefined, measured: { minSamples: 3, days: 7 } });
    expect(ctx.workers.map((m) => m.ref)).toEqual(["local:model-a"]);
    expect(ctx.defaultWorker?.ref).toBe("local:model-a");
    expect(ctx.reviewOn).toBe(false);
    expect([ctx.minSamples, ctx.days]).toEqual([3, 7]);
    expect(projectPlanContextFrom({ ...base, team: undefined, workerLeg: null }).defaultWorker).toBeNull();
  });
});
