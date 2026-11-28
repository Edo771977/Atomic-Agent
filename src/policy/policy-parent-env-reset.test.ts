import { afterEach, describe, expect, it, vi } from "vitest";
import { policyCallRefusal } from "./policy-enforce.js";
import type { EffectivePolicy } from "./policy-evaluator.js";
const names = ["ATOMIC_AGENT_TOOL_CHILD", "ATOMIC_AGENT_POLICY_STATE_DIR", "ATOMIC_AGENT_POLICY_SYSTEM_PATH", "ATOMIC_AGENT_POLICY_FILE_PINS"];
const policy: EffectivePolicy = { sources: [{ kind: "url", state: "loaded", location: "https://fixture.test" }], rules: [], mcpAllowlists: [] };
afterEach(() => vi.unstubAllEnvs());
describe("reset only removes policy metadata actually present in the parent", () => {
  it.each([["env", ["-i", "fixture"]], ["env", ["--ignore-environment", "fixture"]], ["env", ["-", "fixture"]], ["exec", ["-c", "fixture"]], ["sudo", ["env", "-i", "fixture"]], ["env", ["-Senv -i fixture"]], ["sh", ["-c", "env -i fixture"]]] as const)("allows an empty parent metadata inventory for %s %j", (cmd, args) => {
    for (const name of names) vi.stubEnv(name, undefined);
    expect(policyCallRefusal(policy, "os.shell.run", { cmd, args })).toBeNull();
    for (const name of names) {
      vi.stubEnv(name, "fixture");
      expect(policyCallRefusal(policy, "os.shell.run", { cmd, args })).toContain("metadata is reserved");
      vi.stubEnv(name, undefined);
    }
  });
  it("counts an explicitly empty value as present", () => {
    for (const name of names) vi.stubEnv(name, undefined);
    vi.stubEnv("ATOMIC_AGENT_POLICY_FILE_PINS", "");
    expect(policyCallRefusal(policy, "os.shell.run", { cmd: "env", args: ["-i", "fixture"] })).toContain("metadata is reserved");
  });
});
