import { afterEach, describe, expect, it, vi } from "vitest";
import { perTurnModelRefusal } from "./per-turn-model.js";
import { fetchOpenAiCompatModels } from "../llm/provider/openai/fetch-openai-compat-models.js";
import { OPENROUTER_MODELS_CATALOG } from "../llm/provider/openrouter/openrouter-models-catalog.js";
import type { ResolvedLlmConfig } from "../llm/provider/registry/provider-types.js";

/**
 * ATO-1148 adaptation: a per-turn model is a model the entry is known to
 * serve, not any string a client sends (an unbounded id would build one
 * provider copy per string and price it at nothing).
 */
const resolved = {
  activeTextProvider: "compat",
  activeEmbeddingProvider: "compat",
  toolTransport: "auto",
  providers: [
    {
      id: "compat",
      kind: "openai-compatible",
      baseUrl: "https://compat.example.invalid",
      defaultChatModel: "base-model",
      userModels: [{ id: "hand-priced", pricing: { input: 1, output: 2 } }],
    },
    { id: "router", kind: "openrouter", baseUrl: "https://openrouter.ai/api/v1", defaultChatModel: "openrouter/auto" },
    { id: "deepseek", kind: "openai-compatible", baseUrl: "https://api.deepseek.com", defaultChatModel: "deepseek-chat" },
    { id: "listed", kind: "openai-compatible", baseUrl: "https://listed.example.invalid", defaultChatModel: "a" },
  ],
} as unknown as ResolvedLlmConfig;

afterEach(() => vi.unstubAllGlobals());

describe("perTurnModelRefusal: the model must be known for the entry", () => {
  it("refuses a model no source knows for the entry, naming it", () => {
    const refusal = perTurnModelRefusal(resolved, "compat", "made-up-model");
    expect(refusal).toMatch(/made-up-model/);
    expect(refusal).toMatch(/compat/);
  });

  it("takes the entry's own model and its userModels", () => {
    expect(perTurnModelRefusal(resolved, "compat", "base-model")).toBeNull();
    expect(perTurnModelRefusal(resolved, "compat", "hand-priced")).toBeNull();
  });

  it("takes a model of the bundled catalog and of the models.dev snapshot for its preset", () => {
    const catalogModel = [...OPENROUTER_MODELS_CATALOG.keys()].find((id) => id !== "openrouter/auto")!;
    expect(perTurnModelRefusal(resolved, "router", catalogModel)).toBeNull();
    expect(perTurnModelRefusal(resolved, "deepseek", "deepseek-v4-pro")).toBeNull();
    expect(perTurnModelRefusal(resolved, "deepseek", "deepseek-made-up")).not.toBeNull();
  });

  it("takes a model in the entry's cached /v1/models list", async () => {
    expect(perTurnModelRefusal(resolved, "listed", "from-the-list")).not.toBeNull();
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ data: [{ id: "from-the-list" }] }), { status: 200 }));
    await fetchOpenAiCompatModels("https://listed.example.invalid");
    expect(perTurnModelRefusal(resolved, "listed", "from-the-list")).toBeNull();
  });
});
