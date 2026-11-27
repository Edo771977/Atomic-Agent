import { afterEach, describe, expect, it, vi } from "vitest";
import { scriptStream } from "../tools/os/shell/org-script-operands.js";
import { stdinScriptOf } from "../tools/os/shell/shell-command-argv.js";
import { toolCallTarget } from "./policy-targets.js";
import { policyCallRefusal, policyRuleMatch } from "./policy-enforce.js";
import { verifyRunStdinScript } from "../tools/verify/verify-run-guard.js";
import { evaluatePolicy, type EffectivePolicy } from "./policy-evaluator.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { installPolicy } from "./policy-active.js";
import { compressToolResult } from "../compressor/result-compressor.js";
import { verifyRunShellCalls } from "../tools/read-scope/read-scope-targets.js";
import { shellNetworkUseOf } from "../tools/tool-egress.js";

afterEach(() => { installPolicy(null); vi.restoreAllMocks(); });
const policy: EffectivePolicy = { sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "shell", resource: "unrelated-fixture*", effect: "deny" }] };
describe("relative and proc script streams", () => {
  it.each([
    ["../dev/stdin", "/work", "stdin"], ["../../proc/self/fd/3", "/work/project", "unknown"],
    ["/dev/null", "/work", "unknown"], ["/proc/version", "/work", "unknown"],
    ["thread-self/fd/0", "/proc", "stdin"], ["/proc/self/task/42/fd/0", "/work", "stdin"],
    ["/proc/123/task/456/fd/0", "/work", "stdin"],
  ])("classifies %s from %s", (operand, cwd, expected) => expect(scriptStream(operand, cwd)).toBe(expected));
  it.each([["python3", ["../dev/null"]], ["awk", ["-f", "../proc/version"]], [".", ["../proc/version"]], ["make", ["-f", "../dev/null"]]] as const)("keeps shell and verify decisions restrictive for %s", (cmd, args) => {
    for (const tool of ["os.shell.run", "verify.run"]) {
      const target = toolCallTarget(tool, { kind: "command", cmd, args, cwd: "/work", stdin: "fixture" })!;
      for (const effect of ["deny", "ask"] as const) expect(evaluatePolicy({ ...policy, rules: [{ ...policy.rules[0]!, effect }] }, "shell", target.resources, target)?.effect).toBe(effect);
    }
    expect(policyCallRefusal(policy, "os.shell.run", { cmd, args }, "/work")).toContain("policy");
    expect(policyRuleMatch(policy, { tool: "os.shell.run", category: "shell", commandArgv: [cmd, ...args], workdir: "/work" })?.decision).toBe("deny");
  });
  it.each(["thread-self/fd/0", "self/task/42/fd/0"])("associates supplied shell verification stdin at %s", operand => {
    expect(stdinScriptOf("bash", [operand], false, "fixture-command", "/proc")).toEqual({ lines: ["fixture-command"], unreadable: false });
    const args = { kind: "command" as const, cmd: "bash", args: [operand], stdin: "fixture-command", cwd: "/proc", timeoutMs: 1000 };
    expect(verifyRunStdinScript(args, "/proc")).toEqual({ lines: ["fixture-command"], unreadable: false });
    expect(toolCallTarget("verify.run", args)?.resources).toContain("fixture-command");
    expect(verifyRunShellCalls(args, "/work").map(call => call.cmd)).toContain("fixture-command");
  });
  it("preserves the egress check of the supplied body", () => {
    expect(shellNetworkUseOf("verify.run", { cmd: "bash", args: ["self/fd/0"], cwd: "/proc", stdin: "curl https://fixture.test" }, "/work")?.program).toBe("curl");
  });
  it("uses the registry invocation cwd before execution", async () => {
    installPolicy(policy);
    const run = vi.fn(async () => compressToolResult({ tool: "os.shell.run", status: "ok", output: "fixture" }));
    const registry = new ToolRegistry(); registry.register({ name: "os.shell.run", description: "fixture", readonly: false, run });
    await expect(registry.invoke("os.shell.run", { cmd: "python3", args: ["../dev/null"] }, { sessionId: "fixture", stepIndex: 0, workingDir: "/work", signal: new AbortController().signal })).rejects.toThrow("organization's policy");
    expect(run).not.toHaveBeenCalled();
  });
});
