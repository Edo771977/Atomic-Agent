import { afterEach, expect, it, vi } from "vitest";
import { resolveLlmProviderApiKeyWithSource } from "./resolve-llm-api-key.js";

afterEach(() => vi.unstubAllEnvs());

it("withholds the OpenAI fallback after rejecting a malformed stored key", () => {
  vi.stubEnv("OPENAI_COMPAT_API_KEY", undefined);
  vi.stubEnv("OPENAI_API_KEY", "sk-test-only");
  vi.stubEnv("ATOMIC_AGENT_OPENAI_API_KEY", undefined);
  const result = resolveLlmProviderApiKeyWithSource({
    id: "foreign", kind: "openai-compatible",
    baseUrl: "https://foreign.example/v1", apiKey: "<key>",
  });
  expect(result.key).toBeUndefined();
  expect(result.ignored).toMatchObject({ source: { kind: "config" } });
  expect(JSON.stringify(result)).not.toContain("sk-test-only");
});

it("keeps source diagnostics for an allowed OpenAI fallback", () => {
  vi.stubEnv("OPENAI_COMPAT_API_KEY", undefined);
  vi.stubEnv("OPENAI_API_KEY", "sk-test-only");
  expect(resolveLlmProviderApiKeyWithSource({
    id: "openai", kind: "openai-compatible", baseUrl: "https://api.openai.com/v1",
  }).key).toEqual({ value: "sk-test-only", source: { kind: "env", name: "OPENAI_API_KEY" } });
});
