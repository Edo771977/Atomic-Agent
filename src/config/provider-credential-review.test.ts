import { afterEach, expect, it, vi } from "vitest";
import { resolveExtraApiKeys, resolveLlmProviderApiKey } from "./resolve-llm-api-key.js";

afterEach(() => vi.unstubAllEnvs());

it.each(["openai_api_key", "AtOmIc_AgEnT_OpenAI_API_Key"])(
  "scopes the OpenAI alias %s in a case-insensitive environment",
  (name) => {
    const fixture = "synthetic-openai-key";
    const env = new Proxy({}, {
      get: (_, key) => typeof key === "string" && key.toUpperCase() === name.toUpperCase() ? fixture : undefined,
    });
    const original = process.env;
    process.env = env;
    try {
      const entry = { id: "test", kind: "openai-compatible" as const, apiKeyEnvVar: name, extraApiKeyEnvVars: [name] };
      const external = { ...entry, baseUrl: "https://gateway.example.test/v1" };
      const loopback = { ...entry, baseUrl: "http://127.0.0.1:8000/v1" };
      expect([
        resolveLlmProviderApiKey(external), resolveExtraApiKeys(external, env),
        resolveLlmProviderApiKey(loopback), resolveExtraApiKeys(loopback, env),
      ]).toEqual([undefined, [], fixture, [fixture]]);
    } finally {
      process.env = original;
    }
  },
);

it.each([
  ["anthropic", "ANTHROPIC_API_KEY", "https://api.anthropic.com/v1"],
  ["gemini", "GEMINI_API_KEY", "https://generativelanguage.googleapis.com/v1beta"],
  ["openrouter", "OPENROUTER_API_KEY", "https://openrouter.ai/api/v1"],
])("scopes implicit %s credentials to the official origin or loopback", (kind, name, official) => {
  vi.stubEnv(name, "synthetic-vendor-key");
  vi.stubEnv("OPENAI_API_KEY", "synthetic-openai-key");
  const entry = { id: "test", kind };
  const alternate = { ...entry, baseUrl: "https://gateway.example.test" };
  expect(resolveLlmProviderApiKey(entry)).toBe("synthetic-vendor-key");
  expect(resolveLlmProviderApiKey({ ...entry, baseUrl: official })).toBe("synthetic-vendor-key");
  expect(resolveLlmProviderApiKey({ ...entry, baseUrl: "http://[::1]:8000" })).toBe("synthetic-vendor-key");
  expect(resolveLlmProviderApiKey({ ...entry, baseUrl: official.replace("https:", "http:") })).toBeUndefined();
  expect(resolveLlmProviderApiKey(alternate)).toBeUndefined();
  expect(resolveLlmProviderApiKey({ ...alternate, apiKey: "synthetic-gateway-key" })).toBe("synthetic-gateway-key");
  expect(resolveLlmProviderApiKey({ ...alternate, apiKeyEnvVar: name })).toBe("synthetic-vendor-key");
  expect(resolveLlmProviderApiKey({ ...alternate, apiKeyEnvVar: "OPENAI_API_KEY" })).toBeUndefined();
});
