import { describe, expect, it } from "vitest";
import { analyzeShellRules } from "../tools/os/shell/shell-command-argv.js";
import { shellResources } from "./policy-targets.js";
import { evaluatePolicy, type EffectivePolicy } from "./policy-evaluator.js";
import { matchRules, type ApprovalRule } from "../approval/approval-rules.js";

describe("ordinary dynamic arguments versus executable code", () => {
  const forms: Array<[string, boolean]> = [
    ['printf "%s" "$item"', false], ['printf "%s" *.txt', false],
    ['for item in *.txt; do printf "%s" "$item"; done', false],
    ['if [ "$choice" = yes ]; then printf "%s" ordinary; fi', false],
    ['printf "%s" "$(echo ordinary)"', false],
    ['VALUE="$item" printf "%s" ordinary', false],
    ['fixture-block "$action"', true], ['"$program" ordinary', true],
    ['echo "$(fixture-block stop)"', true],
  ];
  it.each(forms)("policy and saved restrictions agree for %s", (line, blocked) => {
    const analysis = analyzeShellRules(line, [], true, "posix");
    for (const effect of ["deny", "ask"] as const) {
      const p: EffectivePolicy = { sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "shell", resource: "fixture-block stop*", effect }] };
      expect(evaluatePolicy(p, "shell", shellResources(line, [], "posix"), { unreadable: analysis.unreadable })?.effect).toBe(blocked ? effect : undefined);
      const rule: ApprovalRule = { id: "fixture", source: "user", createdAt: "", decision: effect, category: "shell", commandPrefix: ["fixture-block", "stop"] };
      expect(matchRules([rule], { tool: "os.shell.run", category: "shell", commandSegments: analysis.segments, commandUnreadable: analysis.unreadable })?.decision).toBe(blocked ? effect : undefined);
    }
  });
});
