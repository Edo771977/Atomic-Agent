import { describe, expect, it, vi } from "vitest";

import { ApprovalGate } from "../../approval/approval-gate.js";
import { compressToolResult } from "../../compressor/result-compressor.js";
import { makeProviderPolicy } from "../../config/project-constraint-match.js";
import { parseHooksObject } from "../../hooks/hook-config.js";
import { ToolHookEngine } from "../../hooks/hook-engine.js";
import { createEgressGuard } from "../../tools/tool-egress.js";
import { ToolRegistry } from "../../tools/tool-registry.js";
import { executeBatch, toBatchInputs } from "./batch-scheduler.js";

/**
 * Issue #33 egress: a tool that would send a constrained folder's content
 * off the machine is refused at dispatch, before the PreToolUse hooks,
 * before its approval prompt and before any request.
 */
function setup(allowedEgress: string[] | null) {
  const emit = vi.fn();
  const approvals = new ApprovalGate({ emit });
  const fetchSpy = vi.fn(async () => "page");
  const hookRun = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1 }));
  const toolHooks = new ToolHookEngine({
    stateDir: "/s",
    load: () => parseHooksObject({ hooks: { PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: "check" }] }] } }, { kind: "user", file: "/s/hooks.json" }),
    run: hookRun,
  });
  const policy = allowedEgress === null
    ? undefined
    : makeProviderPolicy({ key: "/work/client", allowedProviders: ["local-llama"], allowedEgress, matchedDir: "/work/client" });
  const registry = new ToolRegistry({ dispatchGuard: createEgressGuard({ policyForSession: () => policy }) });
  registry.register({
    name: "os.http.request",
    description: "",
    readonly: false,
    run: async (args, ctx) => {
      await approvals.request({ sessionId: ctx.sessionId, tool: "os.http.request", category: "http_write", reason: "POST", affectedResources: [String(args.url)] }, { signal: ctx.signal });
      return compressToolResult({ tool: "os.http.request", status: "ok", output: await fetchSpy() });
    },
  });
  const ctx = { workingDir: "/work/client", sessionId: "s1", stepIndex: 0, signal: new AbortController().signal, toolHooks };
  return { registry, ctx, emit, fetchSpy, hookRun };
}

const BATCH = toBatchInputs([{ tool: "os.http.request", args: { url: "https://api.example.com/v1", method: "POST" } }]);

describe("egress refusal at dispatch (issue #33)", () => {
  it("refuses in a constrained folder before hooks, approval and network", async () => {
    const { registry, ctx, emit, fetchSpy, hookRun } = setup([]);
    const out = await executeBatch(BATCH, registry, ctx);
    const result = out.results[0]!.compressed!;
    expect(result.status).toBe("error");
    expect(result.summary).toContain('os.http.request would send content off this machine; add "http" to projects.constraints["/work/client"].allowedEgress');
    expect(result.details).toMatchObject({ code: "ATOMIC_AGENT_EGRESS_NOT_ALLOWED", refusedBeforeDispatch: true });
    expect(hookRun).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reaches the approval prompt when the class is allowed", async () => {
    const { registry, ctx, emit } = setup(["http"]);
    ctx.signal = AbortSignal.timeout(50);
    await executeBatch(BATCH, registry, ctx);
    expect(emit).toHaveBeenCalled();
  });

  it("reaches the approval prompt in an unconstrained folder", async () => {
    const { registry, ctx, emit } = setup(null);
    ctx.signal = AbortSignal.timeout(50);
    await executeBatch(BATCH, registry, ctx);
    expect(emit).toHaveBeenCalled();
  });
});
