import { describe, expect, it } from "vitest";

import { formatAgentEvent, parseRunArgs } from "./run-agent.js";

/** Issue #37: `run --director <member>` / `--worker <member>` choose the session's fusion team members. */
it("identifies duplicate lesson IDs in a status edit", () => {
  expect(parseRunArgs(["--session", "s1", "--defer-lesson", "storage,storage"]))
    .toEqual({ error: "--defer-lesson: duplicate lesson id storage" });
});

describe("run --director / --worker", () => {
  it("takes a member for each", () => {
    expect(parseRunArgs(["--director", "cloud:model-a", "--worker", "cli:model-w"]))
      .toMatchObject({ director: "cloud:model-a", worker: "cli:model-w" });
    expect(parseRunArgs([])).toMatchObject({ director: null, worker: null, reviewer: null });
  });

  it("refuses a value that is not a member", () => {
    expect(parseRunArgs(["--director"])).toEqual({ error: "--director requires a value" });
    expect(parseRunArgs(["--worker", "no-model"])).toEqual({ error: '--worker expects "<providerId>:<model>"' });
  });

  it("takes --reviewer as a member or \"none\" (issue #71)", () => {
    expect(parseRunArgs(["--reviewer", "codex:model-r"])).toMatchObject({ reviewer: "codex:model-r" });
    expect(parseRunArgs(["--reviewer", "none"])).toMatchObject({ reviewer: "none" });
    expect(parseRunArgs(["--reviewer", "team"])).toMatchObject({ reviewer: "team" });
    expect(parseRunArgs(["--reviewer", "nobody"])).toEqual({ error: '--reviewer expects "<providerId>:<model>", "none" or "team"' });
  });

  it("prints which director the runtime picked", () => {
    expect(formatAgentEvent({
      type: "fusion_director_notice", sessionId: "s", member: "cloud:model-a", reason: "default",
      text: "fusion director: cloud:model-a (the team's default of 2 directors)",
    })).toBe("» fusion director: cloud:model-a (the team's default of 2 directors)");
  });
});
