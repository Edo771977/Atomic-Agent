// Copied by b7b3-candidate.mjs into the disposable candidate only.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fusion from "../../tools/fusion/index.js";
import { registerRuntimeFusionAndReadScope } from "./runtime-tool-catalog.js";
import { getConfig } from "../../config/index.js";
import { resolveLlmConfig } from "../../llm/provider/index.js";
import { ApprovalGate } from "../../approval/approval-gate.js";
import { ToolRegistry } from "../../tools/tool-registry.js";
import { DeclaredInputsRegistry } from "../../tools/os/index.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { resolveRunMode } from "../../llm/run-mode/resolve-run-mode.js";
import { makeProviderPolicy, runWithProviderPolicy } from "../../llm/provider-policy.js";
import { setOfflineNetwork } from "../../llm/offline-network.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import { LlamaServerClient } from "../../llm/llama-server-client.js";
import { installPolicy } from "../../policy/policy-active.js";
import { mergePolicySources } from "../../policy/policy-loader.js";
import { parsePolicyFile } from "../../policy/policy-schema.js";
import { servedModelName } from "../../tools/fusion/served-model-label.js";

const origin = "https://worker.example.test";
const key = "synthetic-review-key";
function setup(url = origin) {
  const config = getConfig();
  config.vision.enabled = false;
  config.llm = { providers: [{ id: "worker-review", kind: "llama-server", url, apiKey: key }], activeTextProvider: "worker-review", activeEmbeddingProvider: "worker-review", toolTransport: "auto" };
  const approvals = new ApprovalGate({ emit: () => {}, level: 5 });
  const builder = vi.spyOn(fusion, "buildFusionDelegateTool").mockReturnValue({ name: "fusion.delegate", description: "capture only", readonly: false, run: async () => { throw Error("fixture never dispatches workers"); } });
  registerRuntimeFusionAndReadScope({ config, toolRegistry: new ToolRegistry(), approvals, dangerous: { approvals, approvalRequired: true }, declaredInputs: new DeclaredInputsRegistry(),
    resolveOriginalRequest: () => undefined, runTurn: async () => { throw Error("no worker"); }, createEphemeralSession: () => createEmptySessionState({ id: "review", workingDir: process.cwd() }),
    prepareLocalLink: async () => {}, emitAgentLoopEventFor: () => {}, resolveCurrentRunMode: () => resolveRunMode(resolveLlmConfig(config)),
    providerRegistry: { getProvider: () => undefined }, llama: { measuredTokensPerSecond: () => null, fetchSlots: async () => ({ slots: [] }), probeHealth: async () => "answered" as const },
    slotManager: { poolSize: () => 2 }, workingDir: process.cwd(), logger: new StructuredLogger({ level: "error", sinks: [] }) });
  const probe = (builder.mock.calls.at(-1)?.[0] as { servedModelOf?: (id: string) => Promise<string | null> })?.servedModelOf;
  expect(probe).toBeTypeOf("function");
  return () => probe!("worker-review");
}
function transport() {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ model_alias: "server-model" }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); setOfflineNetwork(false); installPolicy(null); });

describe("B7b3 candidate probe must meet the fork admission contract", () => {
  it.each(["provider", "egress", "LAN host"])("does not reach transport when %s policy refuses", async reason => {
    const fetch = transport();
    const probe = setup(reason === "LAN host" ? "http://192.168.1.20:8080" : origin);
    const policy = makeProviderPolicy({ key: "review", matchedDir: process.cwd(), allowedProviders: reason === "provider" ? ["local-llama"] : ["worker-review"], allowedEgress: reason === "egress" ? [] : ["http"], allowedProviderHosts: [] });
    await runWithProviderPolicy(policy, () => probe().catch(() => null));
    expect(fetch).not.toHaveBeenCalled();
  });
  it("applies B1 web deny before the authenticated probe", async () => {
    const fetch = transport(); const probe = setup();
    installPolicy(mergePolicySources([{ status: { kind: "system", location: "fixture", state: "loaded" }, file: parsePolicyFile({ rules: [{ action: "webfetch", resource: "worker.example.test", effect: "deny" }] }) }]));
    await probe().catch(() => null);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not invoke fetch while offline", async () => {
    const fetch = transport(); const probe = setup(); setOfflineNetwork(true);
    await probe().catch(() => null);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("sends the configured synthetic key to the configured host only", async () => {
    const fetch = transport(); const probe = setup();
    expect(await probe()).toBe("server-model");
    const [url, options] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).origin).toBe(origin);
    expect(new Headers(options.headers).get("authorization")).toBe("Bearer " + key);
  });
  it("refuses automatic redirects for a credential-bearing probe", async () => {
    const fetch = transport(); const probe = setup(); await probe();
    const [, options] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(["error", "manual"]).toContain(options.redirect);
  });
  it("bounds response bytes before JSON decoding", async () => {
    let jsonReads = 0;
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, headers: new Headers({ "content-length": "1000000000" }), json: async () => { jsonReads++; return { model_alias: "fixture" }; } })));
    await setup()().catch(() => null);
    expect(jsonReads).toBe(0);
  });
  it("has an abort deadline for a signal-aware transport", async () => {
    vi.useFakeTimers();
    let aborted = false;
    const client = new LlamaServerClient({ baseUrl: origin, probeTimeoutMs: 25, fetchImpl: async (_url, init) => new Promise((_resolve, reject) => { init!.signal!.addEventListener("abort", () => { aborted = true; reject(new Error("synthetic timeout")); }, { once: true }); }) });
    const pending = client.fetchProps().catch(() => null);
    await vi.advanceTimersByTimeAsync(30); await pending;
    expect(aborted).toBe(true);
  });
  it("bounds and removes control characters from the untrusted display label", () => {
    const label = servedModelName({ model_alias: "external\u001b[2J\n" + "x".repeat(10_000) });
    expect(label!.length).toBeLessThanOrEqual(160);
    expect(label).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });
  it("does not label a remote local-llama entry with this computer's managed model", () => {
    const mode = resolveRunMode({ providers: [{ id: "local-llama", kind: "llama-server", url: "https://remote.example.test", model: "external-model" }, { id: "cloud", kind: "openrouter", defaultChatModel: "cloud-model" }], activeTextProvider: "cloud", activeEmbeddingProvider: "local-llama", toolTransport: "auto", runMode: { mode: "fusion", fusion: { workerProvider: "local-llama" } } }, { managedModelId: "this-computer-model", localServerUrl: "http://127.0.0.1:19091" });
    expect(mode.workerModel).toBe("external-model");
  });
});
