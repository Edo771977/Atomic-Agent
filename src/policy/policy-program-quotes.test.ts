import { describe, expect, it } from "vitest";
import { analyzeShellRules } from "../tools/os/shell/shell-command-argv.js";
import { shellResources } from "./policy-targets.js";
import { evaluatePolicy, type EffectivePolicy } from "./policy-evaluator.js";
import { matchRules, type ApprovalRule } from "../approval/approval-rules.js";

describe("program-position shell quoting", () => {
  it.each(["$'fixture-block' stop", "$'fixture-\\x62lock' stop", "$'fixture-\\u0062lock' stop", "$\"fixture-block\" stop", "$'fixture\\q' stop"])("restricts %s using parser fixtures only", line => {
    const a = analyzeShellRules("bash", ["-c", line], false);
    for (const effect of ["deny", "ask"] as const) {
      const p: EffectivePolicy = { sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "shell", resource: "fixture-block stop*", effect }] };
      expect(evaluatePolicy(p, "shell", shellResources("bash", ["-c", line]), { unreadable: a.unreadable })?.effect).toBe(effect);
      const r: ApprovalRule = { id: "fixture", source: "user", createdAt: "", decision: effect, category: "shell", commandPrefix: ["fixture-block", "stop"] };
      expect(matchRules([r], { tool: "os.shell.run", category: "shell", commandSegments: a.segments, commandUnreadable: a.unreadable })?.decision).toBe(effect);
    }
  });
  it("does not reinterpret a direct executable's literal argv", () => {
    expect(analyzeShellRules("$'ordinary'", [], false).segments).toEqual([["$'ordinary'"]]);
  });
});
