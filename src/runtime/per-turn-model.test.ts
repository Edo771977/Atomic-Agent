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

describe("perTurnModelRefusal: a fusion team member's model is known for its provider (issue #37)", () => {
  const withTeam = (team: unknown): ResolvedLlmConfig => ({
    ...resolved,
    providers: [...resolved.providers, { id: "codex", kind: "subscription-cli", subscriptionCli: { cli: "codex" } }],
    ...(team === undefined ? {} : { runMode: { fusion: { team } } }),
  }) as unknown as ResolvedLlmConfig;

  it("refuses a subscription CLI's model no source knows", () => {
    expect(perTurnModelRefusal(withTeam(undefined), "codex", "model-team")).toMatch(/model-team/);
  });

  it.each(["directors", "workers", "reviewers"])("takes a model the team lists for that provider among its %s", (role) => {
    const team = { directors: ["compat:base-model"], [role]: ["codex:model-team"] };
    expect(perTurnModelRefusal(withTeam(team), "codex", "model-team")).toBeNull();
  });

  it("a member on another provider does not make the model known here", () => {
    const team = { directors: ["compat:model-team"] };
    expect(perTurnModelRefusal(withTeam(team), "codex", "model-team")).not.toBeNull();
  });
});

it("allows a configured local OpenAI-compatible model for Fusion workers only", () => {
  const local = {
    ...resolved,
    providers: [...resolved.providers,
      { id: "studio", kind: "openai-compatible", baseUrl: "http://127.0.0.1:1234/v1", defaultChatModel: "base" } as const,
      { id: "llama", kind: "llama-server", url: "http://127.0.0.1:8000" } as const,
    ],
    runMode: { mode: "fusion", fusion: { workerProvider: "studio", workerModel: "worker-model" } } as const,
  };
  expect(perTurnModelRefusal(local, "studio", "worker-model")).toMatch(/cloud providers only/);
  expect(perTurnModelRefusal(local, "studio", "worker-model", { fusionWorker: true })).toBeNull();
  expect(perTurnModelRefusal(local, "studio", "unknown", { fusionWorker: true })).toMatch(/not known/);
  expect(perTurnModelRefusal(local, "llama", "worker-model", { fusionWorker: true })).toMatch(/cloud providers only/);
});

it("validates a Fusion worker pin using its parent session's director", () => {
  const config: ResolvedLlmConfig = {
    ...resolved, activeTextProvider: "router",
    providers: [...resolved.providers, {
      id: "studio", kind: "openai-compatible", baseUrl: "http://127.0.0.1:1234/v1", defaultChatModel: "base",
    }],
    runMode: { mode: "fusion", fusion: {
      orchestratorProvider: "compat", workerProvider: "studio", workerModel: "session-worker",
    } },
  };
  const teamChoice = { director: { providerId: "compat", model: "base-model", ref: "compat:base-model" } };
  expect(perTurnModelRefusal(config, "studio", "session-worker", { fusionWorker: true })).toMatch(/not known/);
  expect(perTurnModelRefusal(config, "studio", "session-worker", { fusionWorker: true, teamChoice })).toBeNull();
  expect(perTurnModelRefusal(config, "studio", "other-unknown", { fusionWorker: true, teamChoice })).toMatch(/not known/);
});
