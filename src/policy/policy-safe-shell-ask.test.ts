import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalGate } from "../approval/approval-gate.js";
import { buildOsShellTool } from "../tools/os/shell/shell.js";
import * as jobs from "../sandbox/command-job.js";
import { installPolicy } from "./policy-active.js";
import { policyRuleMatch } from "./policy-enforce.js";

afterEach(() => { installPolicy(null); vi.restoreAllMocks(); });
describe("organization ask reaches the gate for safe shell commands", () => {
  it.each([false, true])("requires an explicit decision even with approvalRequired=%s", async approvalRequired => {
    const policy = { sources: [], mcpAllowlists: [], rules: [{ source: "system" as const, index: 0, action: "shell" as const, resource: "echo*", effect: "ask" as const }] };
    installPolicy(policy);
    const spawn = vi.spyOn(jobs, "startCommandJob").mockImplementation(() => { throw new Error("fake spawn must not be reached"); });
    let prompts = 0;
    const gate = new ApprovalGate({ level: 5, emit: req => { prompts++; gate.reject(req.approvalId, "fixture declines"); } });
    gate.setOrgPolicy(request => policyRuleMatch(policy, request));
    const request = vi.spyOn(gate, "request");
    const tool = buildOsShellTool({ approvals: gate, approvalRequired });
    await expect(tool.run({ cmd: "echo", args: ["fixture"] }, { sessionId: "fixture", workingDir: process.cwd(), stepIndex: 0, signal: new AbortController().signal })).rejects.toMatchObject({ name: "ApprovalDeniedError" });
    expect(prompts).toBe(1);
    expect(request.mock.calls[0]?.[1]).toMatchObject({ requireExplicitDecision: true });
    expect(spawn).not.toHaveBeenCalled();
  });
});
