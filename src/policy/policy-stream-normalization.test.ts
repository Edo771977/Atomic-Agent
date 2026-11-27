import { describe, expect, it } from "vitest";
import { toolCallTarget } from "./policy-targets.js";
import { evaluatePolicy, type EffectivePolicy } from "./policy-evaluator.js";
import { stdinScriptOf } from "../tools/os/shell/shell-command-argv.js";

describe("POSIX lexical script stream identity", () => {
  it.each(["/dev/./fd/3", "/proc/self/./fd/4", "/proc/1/fd/../fd/4", "/dev/../proc/self/fd/3"])("keeps indeterminate %s restrictive in shell and verify", operand => {
    for (const tool of ["os.shell.run", "verify.run"]) {
      const target = toolCallTarget(tool, { kind: "command", cmd: "sh", args: [operand], stdin: "fixture-command" })!;
      for (const effect of ["deny", "ask"] as const) {
        const policy: EffectivePolicy = { sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "shell", resource: "unrelated-fixture*", effect }] };
        expect(evaluatePolicy(policy, "shell", target.resources, target)?.effect).toBe(effect);
      }
    }
    expect(stdinScriptOf("sh", [operand], false, "fixture-command")).toEqual({ lines: [], unreadable: true });
  });
  it.each(["/dev/./stdin", "/dev/./fd/0", "/proc/self/./fd/0"])("binds supplied stdin for %s", operand => {
    expect(stdinScriptOf("sh", [operand], false, "fixture-command")).toEqual({ lines: ["fixture-command"], unreadable: false });
    expect(toolCallTarget("verify.run", { kind: "command", cmd: "sh", args: [operand], stdin: "fixture-command" })?.resources).toContain("fixture-command");
  });
});
