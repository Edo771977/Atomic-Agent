import { afterEach, expect, it, vi } from "vitest";
import { resolveExtraApiKeys, resolveLlmProviderApiKey } from "./resolve-llm-api-key.js";

afterEach(() => vi.restoreAllMocks());

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
