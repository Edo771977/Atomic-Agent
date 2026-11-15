import { describe, expect, it } from "vitest";

import type { TeamFamily, TeamMember } from "../../llm/run-mode/fusion-team.js";
import { resolveTeamRouting, type FusionTeamContext } from "./team-routing.js";

const member = (ref: string): TeamMember => {
  const at = ref.indexOf(":");
  return { providerId: ref.slice(0, at), model: ref.slice(at + 1), ref };
};

const families: Record<string, TeamFamily> = { "api-a": "anthropic", "cli-b": "openai", "local-c": "local" };

function context(over: Partial<FusionTeamContext> = {}): FusionTeamContext {
  return {
    team: {
      directors: ["api-a:model-a", "cli-b:model-x"],
      workers: ["cli-b:model-b", "local-c:model-c", "api-a:model-s"],
      reviewers: ["cli-b:model-r", "api-a:model-o"],
    },
    fusion: { orchestratorProvider: "api-a", workerProvider: "local-c" },
    familyOf: (m) => families[m.providerId] ?? "other",
    reachable: () => true,
    pinsModel: (providerId) => providerId !== "local-c",
    ...over,
  };
}

describe("resolveTeamRouting (issue #37)", () => {
  it("offers the workers the folder allows and that can answer, in config order", () => {
    const routing = resolveTeamRouting(
      context({ reachable: (m) => m.ref !== "api-a:model-s" }),
      { allows: (id) => id !== "cli-b" },
    );
    expect(routing.tasks?.workers.map((m) => m.ref)).toEqual(["local-c:model-c"]);
    expect(routing.tasks?.defaultWorker?.ref).toBe("local-c:model-c");
  });

  it("takes the session's worker when it is still a worker, else workerProvider's, else the first", () => {
    const allows = () => true;
    expect(resolveTeamRouting(context(), { allows, currentWorker: () => member("api-a:model-s") }).tasks?.defaultWorker?.ref)
      .toBe("api-a:model-s");
    expect(resolveTeamRouting(context(), { allows, currentWorker: () => member("api-a:gone") }).tasks?.defaultWorker?.ref)
      .toBe("local-c:model-c");
    expect(resolveTeamRouting(context({ fusion: {} }), { allows }).tasks?.defaultWorker?.ref).toBe("cli-b:model-b");
  });

  it("has no task routing when the team lists no workers", () => {
    const routing = resolveTeamRouting(context({ team: { directors: ["api-a:model-a"] } }), { allows: () => true });
    expect(routing.tasks).toBeUndefined();
    expect(routing.hasReviewers).toBe(false);
  });

  it("takes the turn's director, never a default the turn did not run on", () => {
    expect(resolveTeamRouting(context(), { allows: () => true }).director).toBeNull();
    expect(resolveTeamRouting(context(), { allows: () => true, currentDirector: () => member("cli-b:model-x") }).director?.ref)
      .toBe("cli-b:model-x");
  });

  it("picks a reviewer of another family than the worker, unless crossFamilyReview is off", () => {
    const routing = resolveTeamRouting(context(), { allows: () => true });
    expect(routing.hasReviewers).toBe(true);
    expect(routing.reviewerFor(member("cli-b:model-b"))?.ref).toBe("api-a:model-o");
    expect(routing.reviewerFor(member("local-c:model-c"))?.ref).toBe("cli-b:model-r");
    const same = resolveTeamRouting(
      context({ team: { ...context().team, crossFamilyReview: false } }),
      { allows: () => true },
    );
    expect(same.reviewerFor(member("cli-b:model-b"))?.ref).toBe("cli-b:model-r");
    // A reviewer the folder refuses is never the judge.
    const refused = resolveTeamRouting(context(), { allows: (id) => id !== "api-a" });
    expect(refused.reviewerFor(member("cli-b:model-b"))).toBeNull();
  });
});
