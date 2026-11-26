import { describe, expect, it } from "vitest";
import { analyzeShellRules } from "../tools/os/shell/shell-command-argv.js";
import { evaluatePolicy, type EffectivePolicy } from "./policy-evaluator.js";
import { matchRules, type ApprovalRule } from "../approval/approval-rules.js";

describe("runtime shell definitions", () => {
  it.each(["trap 'ordinary' EXIT", "hash -p /fixture/ordinary named", "source /fixture/ordinary.sh"])("keeps %s opaque to restrictive rules", line => {
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
