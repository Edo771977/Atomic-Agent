import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeShellRules } from "../tools/os/shell/org-shell-analysis.js";
import { ApprovalGate } from "../approval/approval-gate.js";
import { policyRuleMatch } from "./policy-enforce.js";
import type { EffectivePolicy } from "./policy-evaluator.js";

afterEach(() => vi.unstubAllEnvs());
describe("literal Node permission patterns retain the shared lexer boundary", () => {
  for (const level of [1, 5] as const) for (const effect of ["deny", "ask"] as const) {
    it.each(["--allow-fs-read", "--allow-fs-write"])(`${effect}/${level} accepts quoted %s patterns and retains unquoted caution`, flag => {
      vi.stubEnv("NODE_OPTIONS", undefined);
      const policy: EffectivePolicy = { sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "shell", resource: "unrelated-fixture*", effect }] };
      const gate = new ApprovalGate({ level, emit: () => { throw new Error("decision-only fixture"); } });
      gate.setOrgPolicy(req => policyRuleMatch(policy, req));
      for (const [option, expected] of [[`${flag}=/fixture/*`, effect], [`${flag}='/fixture/*'`, null], [`'${flag}=/fixture/*'`, null]] as const) {
        const analysis = analyzeShellRules(`node ${option} fixture.js`, [], true, "posix");
        expect(gate.ruleDecisionFor({ tool: "os.shell.run", category: "shell", sessionId: "fixture", commandSegments: analysis.segments, commandUnreadable: analysis.unreadable })).toBe(expected);
      }
    });
  }
});
