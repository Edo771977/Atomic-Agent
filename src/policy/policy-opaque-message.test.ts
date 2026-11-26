import { describe, expect, it } from "vitest";
import { policyCallRefusal, policyRuleMatch } from "./policy-enforce.js";
import type { EffectivePolicy } from "./policy-evaluator.js";

describe("explain conservative organization decisions", () => {
  it.each(["deny", "ask"] as const)("explains an opaque script in a %s gate decision", effect => {
    const policy: EffectivePolicy = { sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "shell", resource: "unrelated-fixture*", effect }] };
    expect(policyRuleMatch(policy, { tool: "os.shell.run", category: "shell", commandArgv: ["node", "-e", "void 0"] })?.rule.note).toContain("could not be inspected");
    if (effect === "deny") expect(policyCallRefusal(policy, "os.shell.run", { cmd: "node", args: ["-e", "void 0"] })).toContain("could not be inspected");
  });
  it("does not describe a literal matched command as opaque", () => {
    const policy: EffectivePolicy = { sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "shell", resource: "fixture-command", effect: "deny" }] };
    expect(policyCallRefusal(policy, "os.shell.run", { cmd: "fixture-command" })).not.toContain("could not be inspected");
  });
});
