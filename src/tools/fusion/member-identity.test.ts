import { describe, expect, it } from "vitest";

import { reviewerIdentity, sameMember } from "./member-identity.js";

describe("member identity (issue #98)", () => {
  const defaults = (provider: string) => (provider === "codex-cli" ? "gpt-5" : undefined);

  it("the same ref, and null against null, are the same member", () => {
    expect(sameMember("local:qwen", "local:qwen")).toBe(true);
    expect(sameMember(null, null)).toBe(true);
    expect(sameMember(null, "local:qwen")).toBe(false);
  });

  it("an empty model, `default` and a missing model all mean the provider's resolved default", () => {
    expect(sameMember("x:default", "x:")).toBe(true);
    expect(sameMember("x", "x:default")).toBe(true);
    expect(sameMember("codex-cli:", "codex-cli:gpt-5", defaults)).toBe(true);
    expect(sameMember("codex-cli", "codex-cli:gpt-5", defaults)).toBe(true);
    expect(sameMember("codex-cli:default", "codex-cli:gpt-5", defaults)).toBe(true);
  });

  it("another provider, or another model, is another member", () => {
    expect(sameMember("codex-cli:default", "codex-cli:gpt-4", defaults)).toBe(false);
    expect(sameMember("codex-cli:gpt-5", "claude-cli:gpt-5", defaults)).toBe(false);
    // Without a resolver `default` equals only the default spellings.
    expect(sameMember("codex-cli:default", "codex-cli:gpt-5")).toBe(false);
  });

  it("records the plan's ref only when it names a different member", () => {
    expect(reviewerIdentity("codex-cli", "gpt-5", "codex-cli:default", defaults)).toEqual({ provider: "codex-cli", model: "gpt-5" });
    expect(reviewerIdentity("codex-cli", undefined, "codex-cli:default")).toEqual({ provider: "codex-cli" });
    expect(reviewerIdentity("codex-cli", "gpt-5", "claude-cli:sonnet")).toEqual({ provider: "codex-cli", model: "gpt-5", planRef: "claude-cli:sonnet" });
    expect(reviewerIdentity("codex-cli", "gpt-4", "codex-cli:default", defaults)).toEqual({ provider: "codex-cli", model: "gpt-4", planRef: "codex-cli:default" });
  });
});
