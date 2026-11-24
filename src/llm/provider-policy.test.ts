import { describe, expect, it, vi } from "vitest";
import type { AtomicAgentConfig } from "../config/index.js";
import { getConfig } from "../config/index.js";
import { fakeProvider } from "./provider/fake-provider.fixture.js";
import { ProviderRegistry, registerProviderKind } from "./provider/registry/provider-registry.js";
import {
  currentProviderPolicy,
  guardProvider,
  intersectProviderPolicies,
  isProviderNotAllowed,
  makeProviderPolicy,
  noAllowedProviderError,
  providerEndpointOf,
  providerEndpointRefusal,
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

describe("a local provider whose endpoint is another machine (issue #60)", () => {
  const serve = vi.fn(async () => ok);
  const at = (url: string | undefined, local = true) =>
    guardProvider(fakeProvider("local-llama", "grammar", serve), {
      constraintsActive: () => true,
      endpoint: () => ({ local, url }),
    });

  it("refuses a provider allowed by id when its endpoint is on the LAN, saying how to opt in", async () => {
    serve.mockClear();
    const err = await runWithProviderPolicy(policy, () => at("http://192.168.1.20:8080").complete({ prompt: "secret" } as never))
      .then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderNotAllowedError);
    expect((err as ProviderNotAllowedError).reason).toBe("remote-endpoint");
    expect((err as ProviderNotAllowedError).endpointHost).toBe("192.168.1.20");
    expect((err as Error).message).toBe(
      "folder /work/client is restricted to: local-llama; provider \"local-llama\" is allowed, but its endpoint 192.168.1.20 is another machine; nothing was sent. " +
        "To allow it, add \"192.168.1.20\" to projects.constraints[\"/work/client\"].allowedProviderHosts",
    );
    await expect(runWithProviderPolicy(policy, () => at("http://gpu-box.local:1234").completeStream({ prompt: "x" } as never).next()))
      .rejects.toThrow(/endpoint gpu-box\.local is another machine/);
    await expect(runWithProviderPolicy(policy, () => at("http://10.0.0.5:8000").describeImage({ prompt: "x", images: [] })))
      .rejects.toThrow(/endpoint 10\.0\.0\.5 is another machine/);
    expect(serve).not.toHaveBeenCalled();
  });

  it.each([
    "http://127.0.0.1:8080", "http://127.4.5.6:1", "http://localhost:11434", "http://[::1]:8080",
  ])("lets a loopback endpoint through (%s)", async (url) => {
    await expect(runWithProviderPolicy(policy, () => at(url).complete({ prompt: "x" } as never))).resolves.toBe(ok);
  });

  it("still requires a folder opt-in for a wildcard DNS name without a readable address", () => {
    const host = "gpu.nip.io";
    const endpoint = providerEndpointOf({ kind: "llama-server", url: "https://" + host }, undefined);
    expect(providerEndpointRefusal(policy, endpoint)).toEqual({ host });
    expect(providerEndpointRefusal(makeProviderPolicy({ ...policy, allowedProviderHosts: [host] }), endpoint)).toBeUndefined();
  });

  it("lets the host through when the folder lists it in allowedProviderHosts (any spelling of the same host)", async () => {
    const optedIn = makeProviderPolicy({ ...policy, allowedProviderHosts: ["192.168.1.20", "gpu-box.lan"] });
    await expect(runWithProviderPolicy(optedIn, () => at("http://192.168.1.20:8080").complete({ prompt: "x" } as never))).resolves.toBe(ok);
    await expect(runWithProviderPolicy(optedIn, () => at("http://[::ffff:192.168.1.20]:8080").complete({ prompt: "x" } as never))).resolves.toBe(ok);
    await expect(runWithProviderPolicy(optedIn, () => at("http://GPU-BOX.lan.:8080").complete({ prompt: "x" } as never))).resolves.toBe(ok);
    await expect(runWithProviderPolicy(optedIn, () => at("http://192.168.1.21:8080").complete({ prompt: "x" } as never)))
      .rejects.toThrow(/endpoint 192\.168\.1\.21 is another machine/);
  });

  it("fails closed when the endpoint cannot be read", async () => {
    serve.mockClear();
    for (const url of [undefined, "", "not a url"]) {
      await expect(runWithProviderPolicy(policy, () => at(url).complete({ prompt: "x" } as never)))
        .rejects.toThrow(/endpoint cannot be read/);
    }
    expect(serve).not.toHaveBeenCalled();
  });

  it("keeps matching a cloud provider by id alone", async () => {
    const cloud = makeProviderPolicy({ key: "/work/client", allowedProviders: ["local-llama"], matchedDir: "/work/client" });
    await expect(runWithProviderPolicy(cloud, () => at("https://api.example.com", false).complete({ prompt: "x" } as never))).resolves.toBe(ok);
  });

  it("changes nothing for an unconstrained folder or with no constraint at all", async () => {
    serve.mockClear();
    await runWithProviderPolicy(undefined, () => at("http://192.168.1.20:8080").complete({ prompt: "x" } as never));
    const open = guardProvider(fakeProvider("local-llama", "grammar", serve), {
      constraintsActive: () => false,
      endpoint: () => ({ local: true, url: "http://192.168.1.20:8080" }),
    });
    await open.complete({ prompt: "x" } as never);
    expect(serve).toHaveBeenCalledTimes(2);
  });

  it("intersects the listed hosts of two policies (read taint)", () => {
    const a = makeProviderPolicy({ key: "/a", allowedProviders: ["local-llama"], allowedProviderHosts: ["gpu-box.lan", "10.0.0.5"], matchedDir: "/a" });
    const b = makeProviderPolicy({ key: "/b", allowedProviders: ["local-llama"], allowedProviderHosts: ["10.0.0.5"], matchedDir: "/b" });
    expect(intersectProviderPolicies(a, b).allowedProviderHosts).toEqual(["10.0.0.5"]);
    const same = makeProviderPolicy({ key: "/a", allowedProviders: ["local-llama"], matchedDir: "/a" });
    expect(intersectProviderPolicies(a, same).allowedProviderHosts).toEqual([]);
  });
});

describe("providerEndpointOf: which providers are judged by endpoint (issue #60)", () => {
  const managed = "http://127.0.0.1:8080";
  it("judges llama-server and local openai-compatible entries by their URL", () => {
    expect(providerEndpointOf({ kind: "llama-server" }, managed)).toEqual({ local: true, url: managed });
    expect(providerEndpointOf({ kind: "llama-server", url: "http://10.0.0.5:8080" }, managed)).toEqual({ local: true, url: "http://10.0.0.5:8080" });
    expect(providerEndpointOf({ kind: "openai-compatible", baseUrl: "http://192.168.1.20:11434" }, managed))
      .toEqual({ local: true, url: "http://192.168.1.20:11434" });
    expect(providerEndpointOf({ kind: "qwen-openai-compatible", baseUrl: "http://gpu-box.lan:8000" }, managed).local).toBe(true);
    expect(providerEndpointOf({ kind: "openai-compatible" }, managed)).toEqual({ local: true, url: undefined });
  });

  it("leaves known cloud services to the id match", () => {
    expect(providerEndpointOf({ kind: "openai-compatible", baseUrl: "https://api.openai.com/v1" }, managed).local).toBe(false);
    expect(providerEndpointOf({ kind: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1" }, managed).local).toBe(false);
    for (const kind of ["anthropic", "openrouter", "gemini", "aimlapi", "subscription-cli"]) {
      expect(providerEndpointOf({ kind }, managed).local).toBe(false);
    }
  });
});

describe("ProviderRegistry judges a local provider by its configured endpoint (issue #60)", () => {
  const build = async (baseUrl: string) => {
    const config = {
      ...getConfig(),
      projects: { roots: [], constraints: { "/work/client": { allowedProviders: ["lan-llama"] } } },
      llm: {
        activeTextProvider: "lan-llama",
        activeEmbeddingProvider: "lan-llama",
        toolTransport: "auto" as const,
        providers: [{ id: "lan-llama", kind: "openai-compatible", baseUrl, defaultChatModel: "m" }],
      },
    } as AtomicAgentConfig;
    return ProviderRegistry.fromConfig(config, {
      config,
      llamaClient: {} as never,
      getProfile: () => ({}) as never,
      logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
    });
  };

  it("refuses the allowed id before anything is sent when its baseUrl is another computer", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const registry = await build("http://192.168.1.20:11434");
      const lan = makeProviderPolicy({ key: "/work/client", allowedProviders: ["lan-llama"], matchedDir: "/work/client" });
      await expect(runWithProviderPolicy(lan, () => registry.getProvider("lan-llama")!.complete({ prompt: "x" } as never)))
        .rejects.toThrow(/provider "lan-llama" is allowed, but its endpoint 192\.168\.1\.20 is another machine/);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("only a private-network endpoint is judged by place (issue #60 review)", () => {
  const folder = makeProviderPolicy({ key: "/w", allowedProviders: ["x"], matchedDir: "/w" });
  const refusalFor = (baseUrl: string, extra: { modelMode?: "local" | "cloud" } = {}) =>
    providerEndpointRefusal(folder, providerEndpointOf({ kind: "openai-compatible", baseUrl, ...extra }, undefined));

  it.each([
    "https://openrouter.ai/api/v1",
    "https://generativelanguage.googleapis.com/v1beta/openai",
    "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "https://router.huggingface.co/v1",
    "https://llm-gateway.example.com/v1",
    "http://203.0.113.7:8000",
  ])("keeps the id-only match for a public host (%s)", (url) => {
    expect(refusalFor(url)).toBeUndefined();
  });

  it.each([
    ["http://10.1.2.3:8000", "10.1.2.3"],
    ["http://172.16.0.9", "172.16.0.9"],
    ["http://169.254.3.4", "169.254.3.4"],
    ["http://100.100.1.1:11434", "100.100.1.1"],
    ["http://[fd12::5]:8080", "fd12::5"],
    ["http://[fe80::1]:8080", "fe80::1"],
    ["http://gpu.local:1234", "gpu.local"],
    ["http://gpu.lan", "gpu.lan"],
    ["http://gpu.home.arpa", "gpu.home.arpa"],
    ["http://gpu.internal", "gpu.internal"],
    ["http://gpubox:8080", "gpubox"],
  ])("judges a private-network endpoint by place (%s)", (url, host) => {
    expect(refusalFor(url)).toEqual({ host });
  });

  it("leaves an entry marked modelMode cloud to the id match, and still fails closed on an unreadable URL", () => {
    expect(refusalFor("http://192.168.1.20:8080", { modelMode: "cloud" })).toBeUndefined();
    expect(refusalFor("http://192.168.1.20:8080", { modelMode: "local" })).toEqual({ host: "192.168.1.20" });
    expect(refusalFor("not a url")).toEqual({ host: null });
  });
});

describe("this machine is judged by literal loopback only (issue #60 review)", () => {
  const folder = makeProviderPolicy({ key: "/w", allowedProviders: ["x"], matchedDir: "/w" });
  const refusalFor = (baseUrl: string) =>
    providerEndpointRefusal(folder, providerEndpointOf({ kind: "openai-compatible", baseUrl }, undefined));

  it.each([
    "http://localhost:8080", "http://127.0.0.1:8080", "http://127.9.9.9", "http://[::1]:8080", "http://[::ffff:127.0.0.1]:8080",
  ])("lets %s through", (url) => {
    expect(refusalFor(url)).toBeUndefined();
  });

  it.each([
    "http://[2002:7f00:1::1]:8080",
    "http://[64:ff9b::7f00:1]:8080",
    "http://[::127.0.0.1]:8080",
    "http://gpu.localhost:8080",
    "http://0.0.0.0:8080",
  ])("does not take %s for this machine", (url) => {
    expect(refusalFor(url)).not.toBeUndefined();
  });
});
