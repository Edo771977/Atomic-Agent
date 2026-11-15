import { describe, expect, it } from "vitest";

import { ConfigValidationError } from "./config-validation-error.js";
import { parseLlmRunModeConfig, scrubRunModeProviderPins } from "./llm-run-mode-config.js";
import { splitTeamMemberRef } from "./llm-fusion-team-config.js";

/** Issue #37: `llm.runMode.fusion.team`, the directors, workers and reviewers. */
const providers = [
  { id: "local-llama", kind: "llama-server" },
  { id: "anthropic", kind: "anthropic" },
  { id: "codex-cli", kind: "subscription-cli" },
];
const parse = (team: unknown) => parseLlmRunModeConfig({ fusion: { team } }, providers, "llm.runMode");

describe("llm.runMode.fusion.team", () => {
  it("round-trips a full team", () => {
    const team = {
      directors: ["anthropic:model-a", "codex-cli:model-b"],
      workers: ["codex-cli:model-c", "local-llama:model-d"],
      reviewers: ["anthropic:model-e"],
      crossFamilyReview: false,
    };
    expect(parse(team)).toEqual({ fusion: { team } });
    expect(parse(JSON.parse(JSON.stringify(team)))).toEqual({ fusion: { team } });
  });

  it("keeps only the directors when the other lists are absent", () => {
    expect(parse({ directors: ["anthropic:model-a"] })).toEqual({ fusion: { team: { directors: ["anthropic:model-a"] } } });
  });

  it("no team leaves the fusion block as before", () => {
    expect(parseLlmRunModeConfig({ fusion: {} }, providers, "llm.runMode")).toEqual({ fusion: {} });
  });

  it("splits a member at the first colon, so a model id may hold colons", () => {
    expect(splitTeamMemberRef("local-llama:org/model:q4")).toEqual({ providerId: "local-llama", model: "org/model:q4" });
    expect(parse({ directors: ["anthropic:model-a"], workers: ["local-llama:org/model:q4"] }).fusion!.team!.workers)
      .toEqual(["local-llama:org/model:q4"]);
  });

  it.each([
    [null, /team: expected object/],
    [[], /team: expected object/],
    [{}, /team\.directors: expected a non-empty array/],
    [{ directors: [] }, /team\.directors: expected a non-empty array/],
    [{ directors: "anthropic:model-a" }, /team\.directors: expected a non-empty array/],
    [{ directors: ["anthropic"] }, /team\.directors\[0\]: expected "<providerId>:<model>"/],
    [{ directors: [":model-a"] }, /team\.directors\[0\]: expected "<providerId>:<model>"/],
    [{ directors: ["anthropic:"] }, /team\.directors\[0\]: empty model/],
    [{ directors: ["anthropic:  "] }, /team\.directors\[0\]: empty model/],
    [{ directors: [7] }, /team\.directors\[0\]: expected "<providerId>:<model>"/],
    [{ directors: ["nobody:model-a"] }, /team\.directors\[0\]: unknown provider id "nobody"/],
    [{ directors: ["anthropic:model-a", "anthropic:model-a"] }, /team\.directors\[1\]: duplicate member "anthropic:model-a"/],
    [{ directors: ["anthropic:model-a"], workers: [] }, /team\.workers: expected an array of members/],
    [{ directors: ["anthropic:model-a"], workers: "x" }, /team\.workers: expected an array of members/],
    [{ directors: ["anthropic:model-a"], reviewers: ["codex-cli:m", "codex-cli:m"] }, /team\.reviewers\[1\]: duplicate/],
    [{ directors: ["anthropic:model-a"], crossFamilyReview: "yes" }, /team\.crossFamilyReview: expected boolean/],
  ])("rejects %j", (team, message) => {
    expect(() => parse(team)).toThrow(ConfigValidationError);
    expect(() => parse(team)).toThrow(message);
  });

  it("reads review and reviewPasses (issue #38)", () => {
    const team = { directors: ["anthropic:model-a"], reviewers: ["anthropic:model-e"], review: "off", reviewPasses: 0 };
    expect(parse(team).fusion!.team).toEqual(team);
    for (const passes of [1, 2]) {
      expect(parse({ directors: ["anthropic:model-a"], review: "on", reviewPasses: passes }).fusion!.team)
        .toEqual({ directors: ["anthropic:model-a"], review: "on", reviewPasses: passes });
    }
  });

  it("reads an unknown review value as unset, as other enum-like values (newer build)", () => {
    expect(parse({ directors: ["anthropic:model-a"], review: "strict" }).fusion!.team).toEqual({ directors: ["anthropic:model-a"] });
  });

  it.each([
    [{ directors: ["anthropic:model-a"], review: true }, /team\.review: expected on\|off/],
    [{ directors: ["anthropic:model-a"], reviewPasses: 3 }, /team\.reviewPasses: expected 0, 1 or 2/],
    [{ directors: ["anthropic:model-a"], reviewPasses: 1.5 }, /team\.reviewPasses: expected 0, 1 or 2/],
    [{ directors: ["anthropic:model-a"], reviewPasses: "2" }, /team\.reviewPasses: expected 0, 1 or 2/],
  ])("rejects review settings %j", (team, message) => {
    expect(() => parse(team)).toThrow(message);
  });

  it("keeps review and reviewPasses when a provider's members are dropped", () => {
    const runMode = parse({ directors: ["anthropic:model-a"], workers: ["codex-cli:model-c"], review: "on", reviewPasses: 1 });
    expect(scrubRunModeProviderPins(runMode, "codex-cli")!.fusion!.team).toEqual({
      directors: ["anthropic:model-a"],
      review: "on",
      reviewPasses: 1,
    });
  });

  it("lets one member sit in several lists", () => {
    const team = { directors: ["anthropic:model-a"], reviewers: ["anthropic:model-a"] };
    expect(parse(team).fusion!.team).toEqual(team);
  });
});

describe("scrubRunModeProviderPins and the team", () => {
  it("drops the removed provider's members and keeps the others", () => {
    const runMode = parse({
      directors: ["anthropic:model-a", "codex-cli:model-b"],
      workers: ["codex-cli:model-c"],
      reviewers: ["anthropic:model-e", "codex-cli:model-f"],
    });
    expect(scrubRunModeProviderPins(runMode, "codex-cli")!.fusion!.team).toEqual({
      directors: ["anthropic:model-a"],
      reviewers: ["anthropic:model-e"],
    });
  });

  it("drops the whole team when no director is left, so the file stays readable", () => {
    const runMode = parse({ directors: ["codex-cli:model-b"], workers: ["anthropic:model-c"] });
    const scrubbed = scrubRunModeProviderPins(runMode, "codex-cli")!;
    expect(scrubbed.fusion!.team).toBeUndefined();
    expect(() => parseLlmRunModeConfig(scrubbed, providers.filter((p) => p.id !== "codex-cli"), "llm.runMode")).not.toThrow();
  });

  it("returns the input untouched when no member names the provider", () => {
    const runMode = parse({ directors: ["anthropic:model-a"] });
    expect(scrubRunModeProviderPins(runMode, "codex-cli")).toBe(runMode);
  });
});
