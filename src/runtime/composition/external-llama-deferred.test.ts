import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import * as fusion from "../../tools/fusion/index.js";
import { registerRuntimeFusionAndReadScope } from "./runtime-tool-catalog.js";
import { getConfig } from "../../config/index.js";
import { resolveLlmConfig } from "../../llm/provider/index.js";
import { ApprovalGate } from "../../approval/approval-gate.js";
import { ToolRegistry } from "../../tools/tool-registry.js";
import { DeclaredInputsRegistry } from "../../tools/os/index.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { resolveRunMode } from "../../llm/run-mode/resolve-run-mode.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";

afterEach(() => vi.restoreAllMocks());
describe("B7b3 external llama probe remains deferred", () => {
  it.each(["https://external.example.test", "http://192.168.1.20:8080", "http://127.0.0.1:8080"])("does not wire a served-model probe for %s", url => {
    const config = getConfig();
    config.vision.enabled = false;
    config.llm = { providers: [{ id: "review-server", kind: "llama-server", url, apiKey: "synthetic-review-key" }], activeTextProvider: "review-server", activeEmbeddingProvider: "review-server", toolTransport: "auto" };
    const approvals = new ApprovalGate({ emit: () => {}, level: 5 });
    const builder = vi.spyOn(fusion, "buildFusionDelegateTool").mockReturnValue({ name: "fusion.delegate", description: "capture only", readonly: false, run: async () => { throw Error("fixture never dispatches"); } });
    registerRuntimeFusionAndReadScope({ config, toolRegistry: new ToolRegistry(), approvals, dangerous: { approvals, approvalRequired: true }, declaredInputs: new DeclaredInputsRegistry(),
      resolveOriginalRequest: () => undefined, runTurn: async () => { throw Error("no worker"); }, createEphemeralSession: () => createEmptySessionState({ id: "review", workingDir: process.cwd() }),
      prepareLocalLink: async () => {}, emitAgentLoopEventFor: () => {}, resolveCurrentRunMode: () => resolveRunMode(resolveLlmConfig(config)),
      providerRegistry: { getProvider: () => undefined }, llama: { measuredTokensPerSecond: () => null, fetchSlots: async () => ({ slots: [] }), probeHealth: async () => "answered" as const },
      slotManager: { poolSize: () => 2 }, workingDir: process.cwd(), logger: new StructuredLogger({ level: "error", sinks: [] }) });
    expect(builder.mock.calls.at(-1)?.[0]).toBeDefined();
    expect(builder.mock.calls.at(-1)?.[0]).not.toHaveProperty("servedModelOf");
  });
  it("keeps the new untrusted served-label module absent", () => {
    expect(existsSync(new URL("../../tools/fusion/served-model-label.ts", import.meta.url))).toBe(false);
  });
});
