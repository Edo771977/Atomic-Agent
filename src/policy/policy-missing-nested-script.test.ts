import { describe, expect, it } from "vitest";
import { toolCallTarget } from "./policy-targets.js";
import { evaluatePolicy, type EffectivePolicy } from "./policy-evaluator.js";

describe("nested execution option without a determinate script", () => {
  it.each([
    ["sh", ["-c"]], ["sh -c", []], ["bash", ["-c", "-o", "pipefail"]],
    ["xargs", ["sh", "-c"]], ["xargs sh -c", []], ["env", ["sh", "-c"]],
  ] as const)("requires a restrictive decision for %s %j", (cmd, args) => {
    for (const tool of ["os.shell.run", "verify.run"]) {
      const target = toolCallTarget(tool, { kind: "command", cmd, args, stdin: "fixture" })!;
      for (const effect of ["deny", "ask"] as const) {
        const policy: EffectivePolicy = { sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "shell", resource: "unrelated-fixture*", effect }] };
        expect(evaluatePolicy(policy, "shell", target.resources, target)?.effect).toBe(effect);
      }
    }
  });
  it.each(["", "fixture-command"])("retains a determinate script %j", script => {
    expect(toolCallTarget("os.shell.run", { cmd: "sh", args: ["-c", script] })?.unreadable).not.toBe(true);
  });
});
