import { describe, expect, it, vi } from "vitest";
import type { AtomicAgentConfig } from "../config/index.js";
import { getConfig } from "../config/index.js";
import { fakeProvider } from "./provider/fake-provider.fixture.js";
import { ProviderRegistry, registerProviderKind } from "./provider/registry/provider-registry.js";
import {
  currentProviderPolicy,
  guardProvider,
  isProviderNotAllowed,
  makeProviderPolicy,
  noAllowedProviderError,
  PROVIDER_NOT_ALLOWED_CODE,
  ProviderNotAllowedError,
  runWithProviderPolicy,
  runWithProviderRole,
} from "./provider-policy.js";

const ok = { content: "ok", stop: true } as never;
const policy = makeProviderPolicy({ key: "/work/client", allowedProviders: ["local-llama"], matchedDir: "/work/client/src" });

describe("provider policy frame", () => {
  it("carries the policy through awaits and nests a role", async () => {
    await runWithProviderPolicy(policy, async () => {
      await Promise.resolve();
      expect(currentProviderPolicy()?.key).toBe("/work/client");
      await runWithProviderRole("fusion judge", async () => {
        expect(currentProviderPolicy()?.allows("local-llama")).toBe(true);
      });
    });
    expect(currentProviderPolicy()).toBeUndefined();
  });

  it("names the folder, the allowed list and the role in the terminal refusal", () => {
    const err = runWithProviderPolicy(policy, () => noAllowedProviderError(policy), { role: "the main model" });
    expect(err.message).toBe("folder /work/client is restricted to: local-llama; no allowed provider can serve the main model");
    expect(err.code).toBe(PROVIDER_NOT_ALLOWED_CODE);
    expect(isProviderNotAllowed(new Error("wrapped", { cause: err }))).toBe(true);
  });
});

describe("guardProvider", () => {
  const serve = vi.fn(async () => ok);
  const openai = () => guardProvider(fakeProvider("openai", "native_tools", serve), { constraintsActive: () => true });

  it("refuses a disallowed provider before anything is sent, on every entry point", async () => {
    serve.mockClear();
    const p = openai();
    await runWithProviderPolicy(policy, async () => {
      await expect(p.complete({ prompt: "secret" } as never)).rejects.toBeInstanceOf(ProviderNotAllowedError);
      await expect(p.completeStream({ prompt: "secret" } as never).next()).rejects.toThrow(/restricted to: local-llama/);
      await expect(p.describeImage({ prompt: "x", images: [] })).rejects.toThrow(/may not serve/);
    });
    expect(serve).not.toHaveBeenCalled();
  });

  it("refuses describeAudio of a disallowed provider, and keeps it absent where the provider has none (audio.listen)", async () => {
    const heard = vi.fn(async () => ({ text: "the recording", durationMs: 1 }));
    const p = guardProvider({ ...fakeProvider("openai", "native_tools", serve), describeAudio: heard } as never, { constraintsActive: () => true });
    await runWithProviderPolicy(policy, async () => {
      await expect(p.describeAudio!({ prompt: "x", audio: [] } as never)).rejects.toBeInstanceOf(ProviderNotAllowedError);
    });
    expect(heard).not.toHaveBeenCalled();
    expect(openai().describeAudio).toBeUndefined();
  });

  it("refuses a call with no frame while constraints exist (fail closed)", async () => {
    serve.mockClear();
    await expect(openai().complete({ prompt: "x" } as never)).rejects.toThrow(/carries no folder policy/);
    expect(serve).not.toHaveBeenCalled();
  });

  it("lets an unconstrained frame, or no constraint at all, through", async () => {
    serve.mockClear();
    await runWithProviderPolicy(undefined, () => openai().complete({ prompt: "x" } as never));
    const open = guardProvider(fakeProvider("openai", "native_tools", serve), { constraintsActive: () => false });
    await open.complete({ prompt: "x" } as never);
    expect(serve).toHaveBeenCalledTimes(2);
  });

  it("checks the provider's own id and passes other members through", async () => {
    const local = guardProvider(fakeProvider("local-llama", "grammar", async () => ok), { constraintsActive: () => true });
    expect(local.id).toBe("local-llama");
    expect((await local.health()).reachable).toBe(true);
    await expect(runWithProviderPolicy(policy, () => local.complete({ prompt: "x" } as never))).resolves.toBe(ok);
  });
});

describe("ProviderRegistry wraps every provider it builds", () => {
  it("refuses a direct getProvider().complete with no frame while constraints exist", async () => {
    const served = vi.fn(async () => ok);
    registerProviderKind("policy-test-kind", ({ entry }) => fakeProvider(entry.id, "native_tools", served));
    const config = {
      ...getConfig(),
      projects: { roots: [], constraints: { "/work/client": { allowedProviders: ["local-llama"] } } },
      llm: {
        activeTextProvider: "cloudy",
        activeEmbeddingProvider: "cloudy",
        toolTransport: "auto" as const,
        providers: [{ id: "cloudy", kind: "policy-test-kind" }],
      },
    } as AtomicAgentConfig;
    const registry = await ProviderRegistry.fromConfig(config, {
      config,
      llamaClient: {} as never,
      getProfile: () => ({}) as never,
      logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
    });
    await expect(registry.getProvider("cloudy")!.complete({ prompt: "x" } as never)).rejects.toThrow(ProviderNotAllowedError);
    await expect(runWithProviderPolicy(policy, () => registry.activeText.complete({ prompt: "x" } as never)))
      .rejects.toThrow(/provider "cloudy" may not serve/);
    expect(served).not.toHaveBeenCalled();
    await runWithProviderPolicy(undefined, () => registry.activeText.complete({ prompt: "x" } as never));
    expect(served).toHaveBeenCalledTimes(1);
  });
});
