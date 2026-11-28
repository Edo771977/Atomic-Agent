import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../tools/tool-registry.js";
import { SlotManager } from "../llm/slot-manager.js";
import { PLAIN_INSTRUCT_PROFILE } from "../llm/model-profile.js";
import { createEmptySessionState } from "../session/session-state.js";
import { compressToolResult } from "../compressor/result-compressor.js";
import { installPolicy } from "../policy/policy-active.js";
import { mergePolicySources } from "../policy/policy-loader.js";
import { parsePolicyFile } from "../policy/policy-schema.js";
import { resolveToolName } from "./tool-name-resolution.js";
import { executeStep } from "./step-executor.js";
import { createStepBatchPolicy } from "./step/step-batch-policy.js";
import { parseStepBatch } from "./step/step-batch-parsing.js";
import { prepareStepInference } from "./step/step-inference.js";
import { prepareStepDispatch } from "./step/step-evidence.js";
import type { StepContext, StepDependencies } from "./step/step-contract.js";
import type { ToolCallPayload } from "../llm/grammar/tool-call-grammar.js";
import type { CompletionResult } from "../llm/provider/completion-types.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ApprovalGate } from "../approval/approval-gate.js";
import { requireApproval } from "../approval/dangerous-tool.js";
import { confineReads } from "../tools/read-scope/confine-reads.js";
import { buildOsFsWriteTool } from "../tools/os/fs/fs-write.js";

const completion = (calls: ToolCallPayload[]): CompletionResult => ({
  content: JSON.stringify(calls), reasoningContent: "", stop: true, truncated: false,
  timing: { promptMs: 0, predictedMs: 0, promptTokens: 1, predictedTokens: 1 },
  cacheHitTokens: 0, slotId: -1, modelId: "fixture",
});
function fixture(calls: ToolCallPayload[]) {
  const run = vi.fn(async (name: string) => compressToolResult({ tool: name, status: "ok", output: "fixture" }));
  const registry = new ToolRegistry();
  for (const name of ["os.fs.write", "os.fs.read", "reply"]) registry.register({ name, description: name, readonly: name !== "os.fs.write", run: () => run(name) });
  const ctx: StepContext = {
    session: createEmptySessionState({ id: "name-policy-fixture", workingDir: process.cwd() }),
    toolDescriptors: [], skillCatalog: [],
    capabilities: { platform: "win32", arch: "x64", browserChannel: "chrome", workingDir: process.cwd(), hasClipboard: false, hasWmctrl: false, hasNotifications: false },
    stepIndex: 1, signal: new AbortController().signal, maxTokens: 2048,
  };
  const deps: StepDependencies = {
    registry, slotManager: new SlotManager(1), profile: PLAIN_INSTRUCT_PROFILE,
    grammar: 'root ::= "fixture"', toolTransport: "grammar", toolCallAdapter: null,
    supportsSlotAffinity: false, llmComplete: async () => completion(calls),
  };
  return { ctx, deps, run };
}
afterEach(() => installPolicy(null));

describe("B7b2 resolved tool names keep dispatch authority", () => {
  it("rejects every ambiguous nonexact spelling regardless of registry order", () => {
    for (const names of [["mcp.a.b_c", "mcp.a.b-c"], ["mcp.a.b-c", "mcp.a.b_c"]]) {
      const registry = new ToolRegistry();
      for (const name of names) registry.register({ name, description: name, readonly: true, run: async () => compressToolResult({ tool: name, status: "ok", output: "" }) });
      for (const emitted of ["mcp_a_b_c", "mcp__a__b_c", "MCP.A.B_C"]) expect(resolveToolName(emitted, registry)).toBeNull();
      expect(resolveToolName(names[0]!, registry)).toBe(names[0]);
    }
  });
  it("does not let an MCP short name capture a misspelled internal tool", () => {
    const { deps } = fixture([]);
    deps.registry.register({ name: "mcp.untrusted.os.shel", description: "fixture", readonly: true, run: async () => compressToolResult({ tool: "mcp.untrusted.os.shel", status: "ok", output: "" }) });
    expect(resolveToolName("os.shel", deps.registry)).toBeNull();
    expect(resolveToolName("untrusted.os.shel", deps.registry)).toBeNull();
    expect(resolveToolName("fs.write", deps.registry)).toBeNull();
  });
  it("holds a wrapped reply's unsupported claim before dispatch", () => {
    const calls = [{ tool: "functions.reply", args: { text: "Tests pass." } }];
    const { ctx, deps, run } = fixture(calls);
    const markNoticed = vi.fn();
    deps.claimEvidence = { noticed: () => false, markNoticed };
    const policy = createStepBatchPolicy(ctx, deps, () => false);
    const parsed = parseStepBatch({ ctx, deps, prepared: prepareStepInference(ctx, deps), completion: completion(calls), assumesOpenReasoning: () => false, policy });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("fixture did not parse");
    const admitted = prepareStepDispatch(ctx, deps, parsed.batch, completion(calls), policy);
    expect(admitted.calls).toEqual([]);
    expect(admitted.suppressed?.call.tool).toBe("reply");
    expect(markNoticed).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
    expect(calls[0]!.tool).toBe("functions.reply");
  });
  it.each(["os.fs.write", "functions.os.fs.write", '"OS_FS_WRITE"()'])("enforces B1 edit deny on %s", async tool => {
    installPolicy(mergePolicySources([{ status: { kind: "system", location: "fixture", state: "loaded" }, file: parsePolicyFile({ rules: [{ action: "edit", resource: "*", effect: "deny" }] }) }]));
    const { ctx, deps, run } = fixture([{ tool, args: { path: "fixture.txt", content: "fixture" } }]);
    const outcome = await executeStep(ctx, deps);
    expect(run).not.toHaveBeenCalled();
    expect(outcome.toolResults[0]).toMatchObject({ tool: "os.fs.write", status: "error", details: { policyDenied: true } });
  });
  it.each([1, 5] as const)("uses the same filter and approval trim at level %s", async level => {
    const { ctx, deps, run } = fixture([{ tool: "functions.os.fs.write", args: { path: "fixture.txt", content: "fixture" } }, { tool: "os.fs.read", args: { path: "fixture.txt" } }]);
    ctx.toolFilter = name => name !== "os.fs.write";
    deps.approvalPosture = { getLevel: () => level };
    const outcome = await executeStep(ctx, deps);
    expect(run).toHaveBeenCalledOnce();
    expect(outcome.toolResults.map(value => value.tool)).toEqual(["os.fs.read"]);
    expect(run).toHaveBeenCalledWith("os.fs.read");
  });
  it.each([1, 5] as const)("preserves actual approval decisions at level %s", async level => {
    for (const tool of ["os.fs.write", "functions.os.fs.write"]) {
      const { ctx, deps, run } = fixture([{ tool, args: { path: "fixture.txt", content: "fixture" } }]);
      const emit = vi.fn(request => gate.resolve({ approvalId: request.approvalId, approved: false }));
      const gate = new ApprovalGate({ level, emit });
      deps.registry.register({ name: "os.fs.write", description: "fixture", readonly: false, run: async (_args, context) => {
        await requireApproval({ approvals: gate, approvalRequired: true }, { tool: "os.fs.write", sessionId: context.sessionId, category: "fs_write_workspace", reason: "fixture" }, context.signal);
        return run("os.fs.write");
      } });
      const outcome = await executeStep(ctx, deps);
      expect(emit).toHaveBeenCalledTimes(level === 1 ? 1 : 0);
      expect(run).toHaveBeenCalledTimes(level === 1 ? 0 : 1);
      expect(outcome.toolResults[0]?.status).toBe(level === 1 ? "error" : "ok");
    }
  });
  it("keeps read confinement at dispatch after resolving a wrapped name", async () => {
    const { ctx, deps, run } = fixture([{ tool: "functions.os.fs.read", args: { path: join(process.cwd(), "..", "outside.txt") } }]);
    ctx.session.id = "s-w-name-confinement";
    confineReads(deps.registry, { grantedDirs: () => [] });
    const outcome = await executeStep(ctx, deps);
    expect(run).not.toHaveBeenCalled();
    expect(outcome.toolResults[0]).toMatchObject({ tool: "os.fs.read", status: "error" });
  });
  it("keeps declared input replacement protection after resolution", async () => {
    const dir = mkdtempSync(join(tmpdir(), "b7b2-input-"));
    const path = join(dir, "input.txt");
    writeFileSync(path, "original input");
    try {
      const { ctx, deps } = fixture([{ tool: "functions.os.fs.write", args: { path, content: "replacement", overwrite: true } }]);
      const emit = vi.fn();
      const gate = new ApprovalGate({ level: 5, emit });
      deps.registry.register(buildOsFsWriteTool({ approvals: gate, approvalRequired: true, declaredInputs: { inputsOf: () => [path] } }));
      const outcome = await executeStep(ctx, deps);
      expect(outcome.toolResults[0]?.status).toBe("error");
      expect(readFileSync(path, "utf8")).toBe("original input");
      expect(emit).not.toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("keeps cancellation before invocation of a resolved tool", async () => {
    const { ctx, deps, run } = fixture([{ tool: "functions.os.fs.write", args: { path: "fixture.txt", content: "fixture" } }]);
    const abort = new AbortController();
    ctx.signal = abort.signal;
    deps.llmComplete = async () => { abort.abort(); return completion([{ tool: "functions.os.fs.write", args: { path: "fixture.txt", content: "fixture" } }]); };
    await executeStep(ctx, deps).catch(() => undefined);
    expect(run).not.toHaveBeenCalled();
  });
  it("does not rewrite the prompt or catalog during resolution", () => {
    const calls = [{ tool: "functions.reply", args: { text: "answer" } }];
    const { ctx, deps } = fixture(calls);
    const before = prepareStepInference(ctx, deps).prompt;
    const names = deps.registry.list().map(value => value.name);
    const policy = createStepBatchPolicy(ctx, deps, () => false);
    const parsed = parseStepBatch({ ctx, deps, prepared: prepareStepInference(ctx, deps), completion: completion(calls), assumesOpenReasoning: () => false, policy });
    expect(parsed.ok).toBe(true);
    expect(prepareStepInference(ctx, deps).prompt).toEqual(before);
    expect(deps.registry.list().map(value => value.name)).toEqual(names);
  });
});
