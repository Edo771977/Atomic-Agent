import { describe, expect, it } from "vitest";
import { policyCallRefusal } from "./policy-enforce.js";
import type { EffectivePolicy } from "./policy-evaluator.js";
const url = "https://fixture.test/restricted";
const policy: EffectivePolicy = { sources: [], mcpAllowlists: [], rules: [
  { source: "user", index: 0, action: "shell", resource: "*", effect: "allow" },
  { source: "system", index: 0, action: "webfetch", resource: "fixture.test", effect: "deny" },
] };
describe("shell network URLs retain web policy independently of shell policy", () => {
  it.each([["curl", [url]], ["wget", [url]], ["git", ["clone", url]], ["git", ["fetch", url]], ["git", ["pull", url]]] as const)("checks %s %j", (cmd, args) => {
    expect(policyCallRefusal(policy, "os.shell.run", { cmd, args })).toContain("policy");
  });
  it("verify stdin commands retain webfetch policy", () => {
    expect(policyCallRefusal(policy, "verify.run", { kind: "command", cmd: "bash", stdin: `curl ${url}` })).toContain("policy");
  });
});
