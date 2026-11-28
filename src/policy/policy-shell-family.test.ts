import { describe, expect, it } from "vitest";
import { shellRuleSegments, shellRunsUnreadableScript, stdinScriptOf } from "../tools/os/shell/shell-command-argv.js";
import { toolCallTarget } from "./policy-targets.js";
import { evaluatePolicy, type EffectivePolicy } from "./policy-evaluator.js";

const shells = ["rbash", "mksh", "lksh", "ash", "hush", "yash", "posh", "oksh", "loksh", "sash"];
describe("shared shell family and BusyBox applets", () => {
  it.each(shells)("sees nested commands and piped input for %s", shell => {
    expect(shellRuleSegments(shell, ["-c", "fixture-command"], false)).toContainEqual(["fixture-command"]);
    expect(shellRunsUnreadableScript(`printf fixture | ${shell}`, [], true)).toBe(true);
    expect(stdinScriptOf(shell, [], false, "fixture-command")).toEqual({ lines: ["fixture-command"], unreadable: false });
    const target = toolCallTarget("os.shell.run", { cmd: shell, args: ["-c", "fixture-command"] })!;
    const policy: EffectivePolicy = { sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "shell", resource: "fixture-command", effect: "deny" }] };
    expect(evaluatePolicy(policy, "shell", target.resources, target)?.effect).toBe("deny");
    expect(toolCallTarget("os.shell.run", { cmd: `printf fixture | ${shell}` })?.unreadable).toBe(true);
  });
  it.each(["sh", "ash", "hush"])("identifies BusyBox %s rather than the multi-call binary", shell => {
    expect(shellRuleSegments("busybox", [shell, "-c", "fixture-command"], false)).toContainEqual(["fixture-command"]);
    expect(shellRunsUnreadableScript(`printf fixture | busybox ${shell}`, [], true)).toBe(true);
    expect(stdinScriptOf("busybox", [shell], false, "fixture-command")).toEqual({ lines: ["fixture-command"], unreadable: false });
    expect(toolCallTarget("os.shell.run", { cmd: `printf fixture | busybox ${shell}` })?.unreadable).toBe(true);
  });
});
