import { describe, expect, it } from "vitest";
import { policyCallRefusal } from "./policy-enforce.js";
import type { EffectivePolicy } from "./policy-evaluator.js";

const policy: EffectivePolicy = { sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "shell", resource: "unrelated*", effect: "deny" }] };
describe("best-effort visible changes to inherited policy metadata", () => {
  it.each(["ATOMIC_AGENT_TOOL_CHILD", "ATOMIC_AGENT_POLICY_STATE_DIR", "ATOMIC_AGENT_POLICY_SYSTEM_PATH", "ATOMIC_AGENT_POLICY_FILE_PINS"])("refuses explicit modification of %s", name => {
    for (const args of [["-u", name, "fixture"], [`--unset=${name}`, "fixture"], [`${name}=fixture`, "fixture"]]) {
      expect(policyCallRefusal(policy, "os.shell.run", { cmd: "env", args })).toContain("metadata");
    }
    expect(policyCallRefusal(policy, "os.shell.run", { cmd: "printf", args: ["%s", name] })).toBeNull();
  });
});
