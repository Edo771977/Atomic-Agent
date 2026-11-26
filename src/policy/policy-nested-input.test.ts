import { describe, expect, it } from "vitest";
import { toolCallTarget } from "./policy-targets.js";
import { analyzeShellRules } from "../tools/os/shell/shell-command-argv.js";
import { evaluatePolicy, type EffectivePolicy } from "./policy-evaluator.js";
import { matchRules, type ApprovalRule } from "../approval/approval-rules.js";

describe("nested input scripts with direct argv", () => {
  it.each(["printf ordinary | python3", "sh < fixture-input", "bash -c 'printf ordinary | node'"])("classifies %s without executing it", line => {
    const a = analyzeShellRules("bash", ["-c", line], false);
    expect(a.unreadable).toBe(true);
    const target = toolCallTarget("os.shell.run", { cmd: "bash", args: ["-c", line] })!;
    for (const effect of ["deny", "ask"] as const) {
      const p: EffectivePolicy = { sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "shell", resource: "fixture-block *", effect }] };
      expect(evaluatePolicy(p, target.action, target.resources, { unreadable: target.unreadable })?.effect).toBe(effect);
      const rule: ApprovalRule = { id: "fixture", source: "user", createdAt: "", decision: effect, category: "shell", commandPrefix: ["fixture-block"] };
      expect(matchRules([rule], { category: "shell", tool: "verify.run", commandSegments: a.segments, commandUnreadable: a.unreadable })?.decision).toBe(effect);
    }
  });
  it("classifies opaque code inside a supplied verification stdin", () => {
    expect(toolCallTarget("verify.run", { kind: "command", cmd: "bash", args: ["-s"], stdin: "printf ordinary | python3" })?.unreadable).toBe(true);
  });
  it("uses the input shell dialect rather than the host dialect", () => {
    const target = toolCallTarget("verify.run", { kind: "command", cmd: "bash", args: ["-s"], stdin: "for item in ordinary; do fixture-block stop; done" })!;
    expect(target.resources).toContain("fixture-block stop");
  });
  it("keeps direct argv data separate from a pipeline", () => {
    expect(analyzeShellRules("printf", ["ordinary", "|", "python3"], false).unreadable).toBe(false);
  });
});
