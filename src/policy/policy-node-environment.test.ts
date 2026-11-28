import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeShellRules } from "../tools/os/shell/org-shell-analysis.js";
import { policyRuleMatch } from "./policy-enforce.js";
import { ApprovalGate } from "../approval/approval-gate.js";
import type { EffectivePolicy } from "./policy-evaluator.js";

afterEach(() => vi.unstubAllEnvs());
const code = ["--eval=fixture", "--print fixture", "-e fixture", "-p fixture", "-pe fixture", "-rdata:text/javascript,fixture", "--require data:text/javascript,fixture", "--import=data:text/javascript,fixture", "--loader data:text/javascript,fixture", "--experimental-loader=data:text/javascript,fixture"];
const forms = (value: string) => [
  `NODE_OPTIONS='${value}' node fixture.js`,
  `env NODE_OPTIONS='${value}' node fixture.js`,
  `export NODE_OPTIONS='${value}'; node fixture.js`,
  `env -S 'NODE_OPTIONS="${value}" node fixture.js'`,
  `NODE_OPTIONS='${value}' sh -c 'node fixture.js'`,
];
describe("visible NODE_OPTIONS code selectors", () => {
  for (const level of [1, 5] as const) for (const effect of ["deny", "ask"] as const) {
    const policy: EffectivePolicy = { sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "shell", resource: "unrelated-fixture*", effect }] };
    it.each(code.flatMap(forms))(`${effect}/${level} gates %s`, async line => {
      vi.stubEnv("NODE_OPTIONS", undefined);
      const analysis = analyzeShellRules(line, [], true, "posix");
      let prompts = 0;
      const gate = new ApprovalGate({ level, emit: req => { prompts++; gate.reject(req.approvalId, "fixture declines"); } });
      gate.setOrgPolicy(req => policyRuleMatch(policy, req));
      const req = { tool: "os.shell.run", category: "shell" as const, sessionId: "fixture", reason: "fixture", commandSegments: analysis.segments, commandUnreadable: analysis.unreadable };
      expect(gate.ruleDecisionFor(req)).toBe(effect);
      expect((await gate.request(req)).approved).toBe(false);
      expect(prompts).toBe(effect === "ask" ? 1 : 0);
    });
  }
  it.each(forms("--trace-warnings --max-http-header-size=1024"))("retains operational NODE_OPTIONS: %s", line => expect(analyzeShellRules(line, [], true, "posix").unreadable).toBe(false));
  it("reads inherited options and explicit resets, with assignment scope bounded to its command", () => {
    vi.stubEnv("NODE_OPTIONS", "--import=data:text/javascript,fixture");
    expect(analyzeShellRules("node", ["fixture.js"], false).unreadable).toBe(true);
    expect(analyzeShellRules("env", ["-u", "NODE_OPTIONS", "node", "fixture.js"], false).unreadable).toBe(false);
    expect(analyzeShellRules("env", ["-i", "node", "fixture.js"], false).unreadable).toBe(false);
    vi.stubEnv("NODE_OPTIONS", undefined);
    expect(analyzeShellRules("NODE_OPTIONS='--eval=fixture' echo fixture; node fixture.js", [], true, "posix").unreadable).toBe(false);
    expect(analyzeShellRules("export NODE_OPTIONS='--eval=fixture'; unset NODE_OPTIONS; node fixture.js", [], true, "posix").unreadable).toBe(false);
  });
});
