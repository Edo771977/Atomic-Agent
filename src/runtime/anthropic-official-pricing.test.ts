import { describe, expect, it } from "vitest";
import { createRequestBudgetScope } from "./request-budget.js";
import { verifiedAdmissionPricing } from "./link-spend-billing.js";
import { resolveModelPricingFor } from "./resolve-model-pricing.js";
import { FusionTurnBudget } from "../tools/fusion/turn-budget.js";
import { priceCompletion } from "../session/usage-meter.js";
import type { CompletionRequest } from "../llm/provider/completion-types.js";
import type { LlmProvider } from "../llm/provider/llm-provider.js";
import type { LlmProviderConfigEntry } from "../llm/provider/registry/provider-types.js";
import type { ResolvedLlmConfig } from "../llm/provider/registry/index.js";

/**
 * Issue #29 item 9: Anthropic's first-party API had no verified prices, so
 * every cap on a direct Claude link was metered (snapshot prices never
 * admit). A dated table copied from Anthropic's official pricing page
 * prices the first-party host only.
 */
function config(entry: Partial<LlmProviderConfigEntry>): ResolvedLlmConfig {
  return {
    activeTextProvider: "anthropic",
    activeEmbeddingProvider: "anthropic",
    toolTransport: "auto",
    providers: [{ id: "anthropic", kind: "openai-compatible", baseUrl: "https://api.anthropic.com", ...entry } as LlmProviderConfigEntry],
  } as unknown as ResolvedLlmConfig;
}

function scope(resolved: ResolvedLlmConfig, modelId: string, request: Partial<CompletionRequest> = {}) {
  const budget = new FusionTurnBudget();
  budget.begin("p", 0, { usd: 1 });
  const entry = resolved.providers[0]!;
  return createRequestBudgetScope(budget, { sessionId: "p", prompt: "hi", ...request } as CompletionRequest,
    { id: entry.id, supportsRequestBudget: true } as LlmProvider, entry, resolveModelPricingFor(resolved, modelId, entry.id))!;
}

describe("Anthropic's official prices on the first-party API", () => {
  it("prices Fable 5.2 from the official table and counts it as verified", () => {
    const model = resolveModelPricingFor(config({}), "claude-fable-5-2");
    expect(model?.pricingSource).toBe("anthropic-official");
    expect(model?.pricing).toEqual({ input: 8, cacheWrite: 10, cacheRead: 0.2, output: 40 });
    expect(verifiedAdmissionPricing(model)).toEqual(model?.pricing);
  });

  it("enforces a turn cap ahead of sending: hard with a ceiling, soft without", () => {
    const hard = scope(config({}), "claude-fable-5-2", { maxOutputTokens: 4096 });
    expect(hard.mode).toBe("hard");
    const body: Record<string, unknown> = { model: "claude-fable-5-2", messages: [] };
    hard.beforeSend(body);
    expect(body.max_tokens).toBe(4096);
    const soft = scope(config({}), "claude-fable-5-2");
    soft.beforeSend({ model: "claude-fable-5-2", messages: [] });
    expect(soft.mode).toBe("soft");
  });

  it.each([
    ["claude-opus-5-5", { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 }],
    ["claude-sonnet-5-5", { input: 2, cacheWrite: 2.5, cacheRead: 0.1, output: 10 }],
    ["claude-opus-5", { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 }],
    ["claude-opus-4-8", { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 }],
    ["claude-sonnet-5", { input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 }],
    ["claude-sonnet-4-6", { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 }],
    ["claude-haiku-4-5-20251001", { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 }],
  ])("prices %s at the official rates", (id, rates) => {
    expect(resolveModelPricingFor(config({}), id)?.pricing).toEqual(rates);
  });

  it("maps Haiku 5.5's prompts over 100,000 tokens to its long-context rates", () => {
    expect(resolveModelPricingFor(config({}), "claude-haiku-5-5")?.pricing).toEqual({
      input: 0.1, cacheWrite: 0.125, cacheRead: 0.01, output: 0.5,
      longContext: { thresholdTokens: 100_000, input: 0.5, cacheWrite: 0.625, cacheRead: 0.05, output: 2.5 },
    });
  });

  it("is never verified for Claude served by Bedrock, Vertex or OpenRouter", () => {
    const bedrock = config({ id: "bedrock", baseUrl: "https://bedrock-mantle.us-east-1.api.aws" });
    expect(resolveModelPricingFor(bedrock, "claude-fable-5-2", "bedrock")?.pricingSource).toBeUndefined();
    const vertex = config({ id: "vertex", baseUrl: "https://us-east5-aiplatform.googleapis.com/v1/projects/p/locations/us-east5/endpoints/openapi" });
    expect(resolveModelPricingFor(vertex, "claude-fable-5-2", "vertex")?.pricingSource).toBeUndefined();
    const openrouter = config({ id: "openrouter", kind: "openrouter", baseUrl: "https://openrouter.ai/api/v1" });
    expect(resolveModelPricingFor(openrouter, "anthropic/claude-fable-5-2", "openrouter")?.pricingSource).toBeUndefined();
    expect(resolveModelPricingFor(openrouter, "claude-fable-5-2", "openrouter")?.pricingSource).toBeUndefined();
  });

  it("lets a userModels price win over the official table", () => {
    const own = config({ userModels: [{ id: "claude-fable-5-2", kind: "chat", pricing: { input: 1, output: 2 } }] });
    const model = resolveModelPricingFor(own, "claude-fable-5-2");
    expect(model?.source).toBe("user");
    expect(model?.pricingSource).toBeUndefined();
    expect(model?.pricing).toEqual({ input: 1, output: 2 });
  });

  it("applies fast mode and US inference multipliers set through extraBody or params", () => {
    expect(resolveModelPricingFor(config({ extraBody: { speed: "fast" } }), "claude-fable-5-2")?.pricing)
      .toEqual({ input: 16, cacheWrite: 20, cacheRead: 0.4, output: 80 });
    expect(resolveModelPricingFor(config({ extraBody: { speed: "fast" } }), "claude-opus-5-5")?.pricing)
      .toMatchObject({ input: 8, output: 40 });
    const us = resolveModelPricingFor(config({ userModels: [{ id: "claude-opus-5-5", kind: "chat", params: { inference_geo: "us" } }] }), "claude-opus-5-5");
    expect(us?.pricingSource).toBe("anthropic-official");
    expect(us?.pricing?.input).toBeCloseTo(4.4, 9);
    expect(us?.pricing?.output).toBeCloseTo(22, 9);
  });

  it("leaves pricing unverified for a modifier it cannot price", () => {
    // Sonnet 5.5 has no fast mode, and an unknown geography has no published rate.
    expect(resolveModelPricingFor(config({ extraBody: { speed: "fast" } }), "claude-sonnet-5-5")?.pricingSource).toBeUndefined();
    expect(resolveModelPricingFor(config({ extraBody: { inference_geo: "eu" } }), "claude-opus-5-5")?.pricingSource).toBeUndefined();
  });

  it("names the official table as the cost source of an estimate", () => {
    const model = resolveModelPricingFor(config({}), "claude-fable-5-2");
    expect(priceCompletion({ usage: { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 }, model, local: false, plan: false }))
      .toEqual({ kind: "priced", usd: 8, source: "official" });
  });
});
