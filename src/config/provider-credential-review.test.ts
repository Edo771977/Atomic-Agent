import { afterEach, expect, it, vi } from "vitest";
import { resolveExtraApiKeys, resolveLlmProviderApiKey } from "./resolve-llm-api-key.js";
import { findProviderPreset, presetEntryFields } from "../llm/provider/presets/provider-presets.js";

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
  ["aimlapi", "AIMLAPI_API_KEY", "https://api.aimlapi.com/v1"],
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
  expect(resolveLlmProviderApiKey({ ...alternate, apiKeyEnvVar: name })).toBeUndefined();
  expect(resolveLlmProviderApiKey({ ...alternate, apiKeyEnvVar: "OPENAI_API_KEY" })).toBeUndefined();
});

it("scopes the key variable saved by the Anthropic preset to the actual origin", () => {
  vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-vendor-key");
  const preset = findProviderPreset("anthropic")!;
  expect(resolveLlmProviderApiKey({ id: "preset", ...presetEntryFields(preset) })).toBe("synthetic-vendor-key");
  expect(resolveLlmProviderApiKey({ id: "preset", ...presetEntryFields(preset, "https://gateway.example.test") })).toBeUndefined();
});

it.each([
  ["aNtHrOpIc_ApI_kEy", "https://api.anthropic.com/v1"],
  ["gemini_api_key", "https://generativelanguage.googleapis.com/v1beta"],
  ["oPeNrOuTeR_aPi_KeY", "https://openrouter.ai/api"],
  ["aimlapi_api_key", "https://api.aimlapi.com/v1"],
])("binds the named and extra key %s to its own origin", (name, official) => {
  vi.stubEnv(name, "synthetic-vendor-key");
  vi.stubEnv("FIXTURE_GATEWAY_KEY", "synthetic-gateway-key");
  const entry = { id: "fixture", kind: "openai-compatible", apiKeyEnvVar: name,
    extraApiKeyEnvVars: [name, "FIXTURE_GATEWAY_KEY"] };
  const gateway = { ...entry, baseUrl: "https://gateway.example.test" };
  expect(resolveLlmProviderApiKey(gateway)).toBeUndefined();
  expect(resolveExtraApiKeys(gateway)).toEqual(["synthetic-gateway-key"]);
  expect(resolveLlmProviderApiKey({ ...gateway, apiKeyEnvVar: "FIXTURE_GATEWAY_KEY" })).toBe("synthetic-gateway-key");
  for (const baseUrl of [official, "http://127.0.0.1:1234"]) {
    expect(resolveLlmProviderApiKey({ ...entry, baseUrl })).toBe("synthetic-vendor-key");
    expect(resolveExtraApiKeys({ ...entry, baseUrl })).toEqual(["synthetic-vendor-key", "synthetic-gateway-key"]);
  }
});
