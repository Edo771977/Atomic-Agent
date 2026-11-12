import { describe, expect, it } from "vitest";

import {
  cloudModelReasons,
  cloudTakesReasoningOverride,
  reasoningControlFor,
  reasoningLevelsFor,
  reasoningOverrideFromRequest,
} from "./reasoning-levels.js";

describe("reasoningOverrideFromRequest", () => {
  it("reads low, medium and high in any case, and nothing else", () => {
    expect(reasoningOverrideFromRequest("low")).toBe("low");
    expect(reasoningOverrideFromRequest(" MEDIUM ")).toBe("medium");
    expect(reasoningOverrideFromRequest("high")).toBe("high");
    for (const v of ["auto", "minimal", "none", "xhigh", "", null, undefined, 2, { effort: "low" }]) {
      expect(reasoningOverrideFromRequest(v)).toBeUndefined();
    }
  });
});

describe("cloudModelReasons", () => {
  it("knows the reasoning families, with or without a router prefix", () => {
    for (const id of [
      "o3", "o4-mini", "gpt-5.4-mini", "openai/gpt-6-terra", "gpt-oss-120b",
      "claude-opus-5-5", "anthropic/claude-sonnet-4.5", "claude-3-7-sonnet-latest", "claude-haiku-4-5",
      "anthropic/claude-fable-5.2", "gemini-2.5-pro", "google/gemini-3-pro-preview",
      "deepseek/deepseek-r1", "deepseek-reasoner", "x-ai/grok-4", "grok-3-mini",
      "qwen/qwen3-235b-a22b", "qwq-32b", "moonshotai/kimi-k2-thinking", "z-ai/glm-4.6", "minimax/minimax-m2",
    ]) {
      expect(cloudModelReasons(id), id).toBe(true);
    }
  });

  it("leaves models that do not reason, and non-chat variants, out", () => {
    for (const id of [
      "gpt-4o", "gpt-4.1-mini", "gpt-5-chat-latest", "claude-3-5-sonnet-latest", "claude-haiku-3",
      "gemini-2.0-flash", "gemini-2.5-flash-image", "deepseek-chat", "llama-3.3-70b", "mistral-large", "", undefined,
    ]) {
      expect(cloudModelReasons(id), String(id)).toBe(false);
    }
  });
});

describe("cloudTakesReasoningOverride", () => {
  it("needs both a kind with an effort field and a model that reasons", () => {
    expect(cloudTakesReasoningOverride("openrouter", "openai/o3")).toBe(true);
    expect(cloudTakesReasoningOverride("openai-compatible", "gpt-5.4")).toBe(true);
    expect(cloudTakesReasoningOverride("gemini", "gemini-2.5-pro")).toBe(true);
    expect(cloudTakesReasoningOverride("openrouter", "openai/gpt-4o")).toBe(false);
    // A kind without a documented field gets nothing whatever the model.
    expect(cloudTakesReasoningOverride("subscription-cli", "claude-opus-5-5")).toBe(false);
    expect(cloudTakesReasoningOverride(undefined, "o3")).toBe(false);
  });
});

describe("reasoningControlFor / reasoningLevelsFor", () => {
  it("is a budget on a thinking local model, an effort on a reasoning cloud model, none otherwise", () => {
    expect(reasoningControlFor({ providerKind: "llama-server", modelId: "qwen3-8b", localThinks: true })).toBe("budget");
    expect(reasoningControlFor({ providerKind: "llama-server", modelId: "qwen3-8b", localThinks: false })).toBe("none");
    expect(reasoningControlFor({ providerKind: "openrouter", modelId: "anthropic/claude-opus-5.5" })).toBe("effort");
    expect(reasoningControlFor({ providerKind: "openrouter", modelId: "meta-llama/llama-3.3-70b" })).toBe("none");
    expect(reasoningLevelsFor("effort")).toEqual(["auto", "low", "medium", "high"]);
    expect(reasoningLevelsFor("budget")).toEqual(["auto", "low", "medium", "high"]);
    expect(reasoningLevelsFor("none")).toEqual(["auto"]);
  });
});
