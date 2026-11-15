import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AtomicAgentConfig } from "../config/index.js";
import { getConfig } from "../config/index.js";
import { ProviderRegistry, registerProviderKind } from "../llm/provider/registry/provider-registry.js";
import type { LlmProviderConfigEntry, ResolvedLlmConfig } from "../llm/provider/registry/provider-types.js";
import type { CompletionRequest } from "../llm/provider/completion-types.js";
import { DailySpendStore } from "../session/daily-spend.js";
import { budgetPricingModelId } from "./composition/runtime-inference.js";
import { createDailySpendBudget } from "./daily-spend-budget.js";
import { createRequestBudgetScope } from "./request-budget.js";
import { resolveModelPricingFor } from "./resolve-model-pricing.js";

/**
 * ATO-1148 adaptation: a turn on a project's own model is admitted at
 * THAT model's price. Under a daily limit (or a turn cap) an override
 * model with no verified price runs metered and says so, as a
 * snapshot-priced preset does; it never borrows the entry's default
 * model's verified price. The copy inherits the entry's extraBody, so
 * `speed: "fast"` on a model without fast pricing leaves it unverified.
 */
const KIND = "test-per-turn-budget-kind";
registerProviderKind(KIND, ({ entry }) => ({
  id: entry.id,
  name: entry.id,
  chatModelId: entry.defaultChatModel,
  supportsRequestBudget: true,
  close: async () => {},
}) as never);

const entry = {
  id: "claude",
  kind: KIND,
  baseUrl: "https://api.anthropic.com/v1",
  apiKey: "k",
  defaultChatModel: "claude-opus-5-5",
  extraBody: { speed: "fast" },
} as unknown as LlmProviderConfigEntry;
const resolved = {
  activeTextProvider: "claude",
  activeEmbeddingProvider: "claude",
  toolTransport: "auto",
  providers: [entry],
} as unknown as ResolvedLlmConfig;

async function registry() {
  const config = { ...getConfig(), llm: resolved } as unknown as AtomicAgentConfig;
  return ProviderRegistry.fromConfig(config, {
    config,
    llamaClient: {} as never,
    getProfile: () => ({}) as never,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never,
  });
}

function dailyScope(provider: Parameters<typeof createRequestBudgetScope>[2]) {
  const store = new DailySpendStore({ path: join(mkdtempSync(join(tmpdir(), "per-turn-day-")), "daily-spend.json") });
  const daily = createDailySpendBudget(store, () => ({ dailyLimitUsd: 1 }));
  const model = resolveModelPricingFor(resolved, budgetPricingModelId(provider, entry), entry.id);
  return createRequestBudgetScope(undefined, { prompt: "hi" } as CompletionRequest, provider, entry, model, daily)!;
}

describe("a per-turn model under a daily limit", () => {
  it("prices the base model's verified fast rate: no notice", async () => {
    const base = (await registry()).getProvider("claude")!;
    expect(dailyScope(base).hint).toBeUndefined();
  });

  it("meters an override model whose fast price is unknown, and says so", async () => {
    const variant = (await (await registry()).modelVariant("claude", "claude-opus-4-7"))!;
    expect(budgetPricingModelId(variant, entry)).toBe("claude-opus-4-7");
    const scope = dailyScope(variant);
    expect(scope.hintReason).toBe("meter");
    expect(scope.hint).toMatch(/daily spend limit: no verified pricing for provider claude/);
  });
});
