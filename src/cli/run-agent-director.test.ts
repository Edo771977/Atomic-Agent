import { describe, expect, it } from "vitest";

import { formatAgentEvent, parseRunArgs } from "./run-agent.js";

/** Issue #37: `run --director <member>` / `--worker <member>` choose the session's fusion team members. */
describe("run --director / --worker", () => {
  it("takes a member for each", () => {
    expect(parseRunArgs(["--director", "cloud:model-a", "--worker", "cli:model-w"]))
      .toMatchObject({ director: "cloud:model-a", worker: "cli:model-w" });
    expect(parseRunArgs([])).toMatchObject({ director: null, worker: null });
  });

  it("refuses a value that is not a member", () => {
    expect(parseRunArgs(["--director"])).toEqual({ error: "--director requires a value" });
    expect(parseRunArgs(["--worker", "no-model"])).toEqual({ error: '--worker expects "<providerId>:<model>"' });
  });

  it("prints which director the runtime picked", () => {
    expect(formatAgentEvent({
      type: "fusion_director_notice", sessionId: "s", member: "cloud:model-a", reason: "default",
      text: "fusion director: cloud:model-a (the team's default of 2 directors)",
    })).toBe("» fusion director: cloud:model-a (the team's default of 2 directors)");
  });
});
