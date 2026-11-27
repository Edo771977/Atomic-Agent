import { existsSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import type { AtomicAgentConfig } from "../../config/index.js";
import { ENV_SETTINGS } from "../../config/env-settings.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { makeProviderPolicy, runWithProviderPolicy } from "../../llm/provider-policy.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import { createNextStepSuggester } from "./runtime-next-step.js";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("keeps the deferred endpoint implementation and environment settings absent", () => {
  expect(existsSync(new URL("../../session/next-step-endpoint.ts", import.meta.url))).toBe(false);
  expect(JSON.stringify(ENV_SETTINGS)).not.toContain("ATOMIC_AGENT_NEXT_STEP_");
});

it.each(["http://127.0.0.1:8081/v1", "https://suggestions.invalid/v1"])(
  "ignores the deferred endpoint %s and uses the established model seam", async url => {
    vi.stubEnv("ATOMIC_AGENT_NEXT_STEP_URL", url);
    vi.stubEnv("ATOMIC_AGENT_NEXT_STEP_MODEL", "unvalidated-model");
    vi.stubEnv("ATOMIC_AGENT_NEXT_STEP_API_KEY", "c2b-synthetic-key-with-spaces");
    const fetchEndpoint = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "external output" } }] })));
    vi.stubGlobal("fetch", fetchEndpoint);
    const config = { agent: {}, tui: { nextStepSuggestions: true }, localModels: { useServerTemplate: "off" } } as unknown as AtomicAgentConfig;
    const state = { ...createEmptySessionState({ id: "c2b-absent", workingDir: "/fixture" }), turnCount: 1,
      turns: [{ kind: "user" as const, text: "Write a parser", at: 1 }, { kind: "assistant_reply" as const, text: "Parser is ready", at: 2 }] };
    const llmComplete = vi.fn(async () => ({ content: "Add parser tests", reasoningContent: "", stop: true, truncated: false,
      timing: { promptMs: 1, predictedMs: 1, promptTokens: 1, predictedTokens: 1 }, cacheHitTokens: 0, slotId: -1, modelId: null }));
    const save = vi.fn(); const records: unknown[] = [];
    const suggester = createNextStepSuggester({ getConfig: () => config, sessionStore: { load: () => state, save }, llmComplete,
      slotManager: { sideCallSlotId: () => 3 }, resolveTransport: () => "native_tools", pending: new Set(), isShutdown: () => false,
      logger: new StructuredLogger({ level: "debug", sinks: [record => records.push(record)] }) });
    const policy = makeProviderPolicy({ key: "local-only", matchedDir: "/fixture", allowedProviders: ["local-llama"] });
    for (const offline of ["0", "1"]) {
      vi.stubEnv("ATOMIC_AGENT_OFFLINE", offline);
      await runWithProviderPolicy(policy, () => suggester.maybeSuggest(state, "http", "local-llama"), { sessionId: state.id });
    }
    expect(fetchEndpoint).not.toHaveBeenCalled();
    expect(llmComplete).toHaveBeenCalledTimes(2);
    for (const [request] of llmComplete.mock.calls as unknown as Array<[{ providerId: string; sessionId: string }]>) {
      expect(request.providerId).toBe("local-llama");
      expect(request.sessionId).toBe("next-step:c2b-absent");
    }
    expect(JSON.stringify(records)).not.toContain("c2b-synthetic-key-with-spaces");
    expect(state.turns).toHaveLength(2);
  },
);
