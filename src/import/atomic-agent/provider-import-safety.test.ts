import { afterEach, expect, it, vi } from "vitest";
import { stripUnknownKeySources } from "../../setup-share/known-provider-env.js";
import { buildApiKeyCommandEnv } from "../../llm/provider/openai/api-key-command-env.js";
import { createApiKeyCommandSource } from "../../llm/provider/openai/api-key-command.js";

afterEach(() => vi.unstubAllEnvs());

it.each([
  ["anthropic", "https://api.anthropic.com/v1", "ANTHROPIC_API_KEY"],
  ["openai-compatible", "https://api.openai.com/v1", "OPENAI_API_KEY"],
  ["gemini", "https://generativelanguage.googleapis.com", "GEMINI_API_KEY"],
  ["aimlapi", "https://api.aimlapi.com/v1", "AIMLAPI_API_KEY"],
] as const)("disarms foreign %s endpoints, key commands and native variable names", (kind, _official, name) => {
  const entry: Record<string, unknown> = { id: "fixture", kind, baseUrl: "https://user:password-sentinel@gateway.example/v1", apiKeyCommand: ["command-sentinel"], apiKeyEnvVar: name, extraApiKeyEnvVars: [name] };
  const dropped = stripUnknownKeySources(entry);
  expect(entry).not.toHaveProperty("baseUrl");
  expect(entry).not.toHaveProperty("apiKeyCommand");
  expect(entry).not.toHaveProperty("apiKeyEnvVar");
  expect(entry).not.toHaveProperty("extraApiKeyEnvVars");
  expect(JSON.stringify(dropped)).not.toMatch(/password-sentinel|command-sentinel|gateway/);
});


it("keeps helper sign-ins separate from provider credentials and sensitive agent metadata", () => {
  const names = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ATOMIC_AGENT_API_KEY", "ATOMIC_AGENT_NEXT_STEP_URL", "ATOMIC_AGENT_SENTRY_DSN", "AWS_OTHER_API_KEY", "AZURE_OTHER_TOKEN", "CLOUDSDK_OTHER_SECRET", "MY_VENDOR_SECRET"];
  const env = buildApiKeyCommandEnv({ PATH: "fixture-path", BW_SESSION: "helper-session", ...Object.fromEntries(names.map((name, i) => [name, `sentinel-${i}`])) });
  for (const name of names) expect(env[name], name).toBeUndefined();
  expect(Object.values(env).some(value => value?.startsWith("sentinel-"))).toBe(false);
  expect(env.PATH).toBe("fixture-path");
  expect(env.BW_SESSION).toBe("helper-session");
});

it("marks key helpers as agent children so they cannot answer operator-only CLI decisions", () => {
  expect(buildApiKeyCommandEnv({ PATH: "fixture-path" }).ATOMIC_AGENT_TOOL_CHILD).toBe("1");
});

it("does not echo command bytes, provider labels or error codes supplied by a helper", async () => {
  const source = createApiKeyCommandSource(["command-sentinel", "arg-sentinel"], { label: "https://user:password-sentinel@host", run: async () => { throw { code: "secret-sentinel", stderr: "stderr-sentinel" }; } });
  const message = await source.get().catch((err: Error) => err.message);
  expect(message).not.toMatch(/sentinel|https:|user:/);
});
