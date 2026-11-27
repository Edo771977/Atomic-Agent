import { describe, expect, it } from "vitest";
import { analyzeShellRules } from "../tools/os/shell/org-shell-analysis.js";
import { evaluatePolicy, type EffectivePolicy } from "./policy-evaluator.js";
import { matchRules, type ApprovalRule } from "../approval/approval-rules.js";

describe("runtime shell definitions", () => {
  it.each([["python3", "-cprint('fixture')"], ["node", "-evoid(0)"], ["perl", "-we1"], ["ruby", "-e1"], ["php", "-recho 1;"]])("keeps attached inline flags opaque in %s", (cmd, ...args) => {
    expect(analyzeShellRules(cmd, args, false).unreadable).toBe(true);
  });
  it.each([["python3", "-c", "print('fixture')"], ["node", "--eval=void 0"], ["perl", "-e", "1"], ["ruby", "-e", "1"], ["php", "-r", "echo 1;"], ["awk", "BEGIN { system(\"fixture\") }"], ["sed", "-e", "e fixture"]])("classifies inline code in %s without interpreting it", (cmd, ...args) => {
    expect(analyzeShellRules(cmd, args, false).unreadable).toBe(true);
    expect(analyzeShellRules("printf", [cmd, ...args], false).unreadable).toBe(false);
  });
  it.each(["trap 'ordinary' EXIT", "hash -p /fixture/ordinary named"])("keeps %s opaque to restrictive rules", line => {
    const analysis = analyzeShellRules("bash", ["-c", line], false);
    expect(analysis.unreadable).toBe(true);
    for (const effect of ["deny", "ask"] as const) {
      const policy: EffectivePolicy = { sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "shell", resource: "fixture-block*", effect }] };
      expect(evaluatePolicy(policy, "shell", analysis.segments.map(words => words.join(" ")), analysis)?.effect).toBe(effect);
      const rule: ApprovalRule = { id: "fixture", source: "user", createdAt: "", category: "shell", decision: effect, commandPrefix: ["fixture-block"] };
      expect(matchRules([rule], { tool: "os.shell.run", category: "shell", commandSegments: analysis.segments, commandUnreadable: analysis.unreadable })?.decision).toBe(effect);
    }
  });
});
