import { afterEach, expect, it, vi } from "vitest";
import { getConfig, type AtomicAgentConfig } from "../../../config/index.js";
import { createApiKeyCommandSource, resetCommandIssuedSecrets } from "./api-key-command.js";
import * as command from "./api-key-command.js";
import { registerBuiltInProviderKinds } from "../registry/register-built-in-providers.js";
import { getProviderFactory } from "../registry/provider-types.js";

afterEach(() => { vi.restoreAllMocks(); resetCommandIssuedSecrets(); });

it("excludes explicitly configured ordinary credential names and aliases of their values", async () => {
  let seen: NodeJS.ProcessEnv | undefined;
  const source = createApiKeyCommandSource(["fixture-helper"], {
    label: "fixture", baseEnv: () => ({ PATH: "path", CORP_LOGIN: "credential-sentinel", HARMLESS_ALIAS: "credential-sentinel", BW_SESSION: "credential-sentinel", PUBLIC_ALIAS: "inline-sentinel" }),
    credentials: () => ({ names: ["CORP_LOGIN"], values: ["inline-sentinel"] }),
    run: async (_argv, _timeout, env) => { seen = env; return "fixture-token"; },
  });
  await source.get();
  expect(seen?.CORP_LOGIN).toBeUndefined();
  expect(seen?.HARMLESS_ALIAS).toBeUndefined();
  expect(seen?.BW_SESSION).toBeUndefined();
  expect(seen?.PUBLIC_ALIAS).toBeUndefined();
  expect(seen?.PATH).toBe("path");
});

it("wires all configured credentials into the actual provider factory helper source", async () => {
  const base = getConfig();
  const config: AtomicAgentConfig = { ...base, llm: { ...base.llm, activeTextProvider: "other", activeEmbeddingProvider: "other", toolTransport: "auto", providers: [{ id: "other", kind: "openai-compatible", apiKeyEnvVar: "CORP_LOGIN", extraApiKeyEnvVars: ["SECOND_LOGIN"], apiKey: "inline-sentinel", apiKeyHeader: "X-Login", headers: { Authorization: "Bearer header-sentinel", "X-Login": "custom-header-sentinel" } }] } };
  const spy = vi.spyOn(command, "sharedApiKeyCommandSource").mockReturnValue({ get: async () => "fixture-token", invalidate: () => undefined });
  registerBuiltInProviderKinds();
  await getProviderFactory("openai-compatible")!({ config, entry: { id: "helper", kind: "openai-compatible", baseUrl: "https://api.openai.com/v1", defaultChatModel: "fixture", apiKeyCommand: ["fixture-helper"] }, logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never });
  const credentials = spy.mock.calls[0]?.[2]?.();
  expect(credentials?.names).toEqual(expect.arrayContaining(["CORP_LOGIN", "SECOND_LOGIN"]));
  expect(credentials?.values).toEqual(expect.arrayContaining(["inline-sentinel", "Bearer header-sentinel", "header-sentinel", "custom-header-sentinel"]));
});
