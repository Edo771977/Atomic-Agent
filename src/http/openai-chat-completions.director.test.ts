import { describe, expect, it } from "vitest";

import { parseTeamChoice } from "./openai-chat-completions.js";

/**
 * Issue #37: a client may name the session's fusion director and its
 * preferred worker per request (`director`, `worker`, each
 * `"<providerId>:<model>"`). The turn checks them against the team; the
 * request only refuses what cannot be a member at all.
 */
describe("parseTeamChoice", () => {
  it("is empty when the request names neither", () => {
    expect(parseTeamChoice({})).toEqual({});
    expect(parseTeamChoice({ director: null, worker: null })).toEqual({});
  });

  it("takes trimmed member refs", () => {
    expect(parseTeamChoice({ director: " cloud:model-a ", worker: "cli:model-w" }))
      .toEqual({ director: "cloud:model-a", worker: "cli:model-w" });
  });

  it("refuses a value that is not a member ref, naming the field", () => {
    expect(parseTeamChoice({ director: 7 })).toEqual({ error: "director must be \"<providerId>:<model>\"", param: "director" });
    expect(parseTeamChoice({ worker: "no-model" })).toEqual({ error: "worker must be \"<providerId>:<model>\"", param: "worker" });
    expect(parseTeamChoice({ director: "a:b\nc" })).toMatchObject({ param: "director" });
  });

  it("takes a reviewer ref or the literal \"none\" (issue #71)", () => {
    expect(parseTeamChoice({ reviewer: " codex:model-r " })).toEqual({ reviewer: "codex:model-r" });
    expect(parseTeamChoice({ reviewer: "none" })).toEqual({ reviewer: "none" });
    expect(parseTeamChoice({ reviewer: "team" })).toEqual({ reviewer: "team" });
    expect(parseTeamChoice({ reviewer: "nobody" })).toEqual({ error: "reviewer must be \"<providerId>:<model>\", \"none\" or \"team\"", param: "reviewer" });
  });
});
