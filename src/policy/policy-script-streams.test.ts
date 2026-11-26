import { describe, expect, it } from "vitest";
import { stdinScriptOf } from "../tools/os/shell/shell-command-argv.js";
import { toolCallTarget } from "./policy-targets.js";
import { evaluatePolicy, type EffectivePolicy } from "./policy-evaluator.js";

describe("script stream operands", () => {
  it.each(["-Ssh /dev/stdin", "--split-string=sh /dev/stdin"])("aligns verify stdin through %s", option => {
    expect(stdinScriptOf("env", [option], false, "fixture-command")).toEqual({ lines: ["fixture-command"], unreadable: false });
    expect(toolCallTarget("verify.run", { kind: "command", cmd: "env", args: [option], stdin: "fixture-command" })?.resources).toContain("fixture-command");
  });
  it.each(["/dev/stdin", "/dev/fd/0", "/proc/self/fd/0"])("reads supplied POSIX verification stdin through %s", operand => {
    expect(stdinScriptOf("sh", [operand], false, "fixture-command")).toEqual({ lines: ["fixture-command"], unreadable: false });
    expect(toolCallTarget("verify.run", { kind: "command", cmd: "sh", args: [operand], stdin: "fixture-command" })?.resources).toContain("fixture-command");
  });
  it.each([
    ["sh", ["/dev/fd/3"]], ["python3", ["/proc/self/fd/4"]], ["node", ["/dev/stdin"]],
    ["sh /dev/fd/3", []], ["bash", ["-c", "sh <(printf fixture)"]],
  ] as const)("keeps indeterminate stream programs restrictive: %s", (cmd, args) => {
    const target = toolCallTarget("os.shell.run", { cmd, args })!;
    for (const effect of ["deny", "ask"] as const) {
      const policy: EffectivePolicy = { sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "shell", resource: "unrelated-fixture*", effect }] };
      expect(evaluatePolicy(policy, "shell", target.resources, target)?.effect).toBe(effect);
    }
  });
  it("does not reinterpret descriptor-like script arguments", () => {
    expect(toolCallTarget("os.shell.run", { cmd: "python3", args: ["fixture.py", "/dev/fd/3"] })?.unreadable).not.toBe(true);
    expect(stdinScriptOf("python3", ["-W", "error", "-"], false, "pass")).toEqual({ lines: [], unreadable: true });
  });
});
