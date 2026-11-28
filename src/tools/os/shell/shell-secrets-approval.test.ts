import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalGate, type ApprovalRequest } from "../../../approval/approval-gate.js";
import * as jobs from "../../../sandbox/command-job.js";
import { installPolicy } from "../../../policy/policy-active.js";
import { policyRuleMatch } from "../../../policy/policy-enforce.js";
import { evaluatePolicy, type EffectivePolicy } from "../../../policy/policy-evaluator.js";
import { shellResources } from "../../../policy/policy-targets.js";
import { analyzeShellRules } from "./org-shell-analysis.js";
import { buildOsShellTool } from "./shell.js";
import { checkShellCommandGuard } from "../shell-command-guard/index.js";

const variants = [
  "atomic-agent config secrets env", "/usr/local/bin/atomic-agent config secrets env",
  "npx -y atomic-agent config secrets env", "node dist/cli/index.js config secrets env",
  "echo env | xargs atag config secrets", "echo env | xargs -I% atag config secrets %",
  "atag config secrets $(echo env)", "eval 'atag config secrets env'",
  "sh -c 'atag config secrets env'", "atag $A secrets env", "atag config $S env",
  "atag config secrets $SUB", "atag config --verbose secrets --quiet ENV",
] as const;
afterEach(() => { installPolicy(null); vi.restoreAllMocks(); });
beforeEach(() => { vi.spyOn(jobs, "startCommandJob").mockImplementation(() => { throw new Error("fixture reached execution"); }); });

describe.each([1, 5] as const)("credential moves at level %s", level => {
  it.each(variants)("asks before any execution: %s", async cmd => {
    const emit = vi.fn((req: ApprovalRequest) => { gate.resolve({ approvalId: req.approvalId, approved: false }); });
    const gate = new ApprovalGate({ level, emit });
    const tool = buildOsShellTool({ approvals: gate, approvalRequired: true });
    await expect(tool.run({ cmd }, { workingDir: process.cwd(), sessionId: "fixture", stepIndex: 0, signal: new AbortController().signal })).rejects.toMatchObject({ name: "ApprovalDeniedError" });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![0]).toMatchObject({ category: "shell_dangerous", oneShot: true });
  });
  it.each(variants)("B1 deny precedes approval: %s", async cmd => {
    const policy: EffectivePolicy = { sources: [], mcpAllowlists: [], rules: [{ action: "shell", resource: "*", effect: "deny", source: "system", index: 0 }] };
    installPolicy(policy);
    const emit = vi.fn();
    const gate = new ApprovalGate({ level, emit });
    gate.setOrgPolicy(request => policyRuleMatch(policy, request));
    await expect(buildOsShellTool({ approvals: gate, approvalRequired: true }).run({ cmd }, { workingDir: process.cwd(), sessionId: "fixture", stepIndex: 0, signal: new AbortController().signal })).rejects.toThrow(/policy/i);
    expect(emit).not.toHaveBeenCalled();
  });
});

it.each(["atomic-agent config get", "atomic-agent config list", "env", "printenv PATH", "xargs grep"])("keeps ordinary commands off the dangerous path: %s", line => {
  const [cmd, ...rawArgs] = line.split(" ");
  expect(checkShellCommandGuard({ cmd: cmd!, rawArgs, cwd: process.cwd() }).rule).not.toMatch(/^dangerous\./);
});

it.each(variants)("preserves B1 POSIX matching for a credential-specific deny: %s", line => {
  const analysis = analyzeShellRules(line, [], true, "posix");
  const policy: EffectivePolicy = { sources: [], mcpAllowlists: [], rules: [{ action: "shell", resource: "*config*secrets*", effect: "deny", source: "system", index: 0 }] };
  expect(evaluatePolicy(policy, "shell", shellResources(line, [], "posix"), { unreadable: analysis.unreadable })?.effect).toBe("deny");
});
