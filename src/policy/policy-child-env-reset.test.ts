import { describe, expect, it } from "vitest";
import { policyCallRefusal } from "./policy-enforce.js";
import type { EffectivePolicy } from "./policy-evaluator.js";

const policy: EffectivePolicy = { sources: [{ kind: "url", state: "loaded", location: "https://fixture.test" }], mcpAllowlists: [], rules: [] };
describe("visible child environment reset and export changes", () => {
  it.each([
    ["env", ["-i", "fixture-command"]], ["env", ["--ignore-environment", "fixture-command"]],
    ["env", ["-", "fixture-command"]], ["sudo", ["env", "-i", "fixture-command"]],
    ["env", ["-Senv -i fixture-command"]], ["exec", ["-c", "fixture-command"]],
    ["declare", ["+x", "ATOMIC_AGENT_TOOL_CHILD"]], ["typeset", ["+x", "ATOMIC_AGENT_POLICY_FILE_PINS"]],
    ["builtin", ["export", "-n", "ATOMIC_AGENT_TOOL_CHILD"]], ["sh", ["-c", "env -i fixture-command"]],
  ] as const)("refuses the recognized metadata change in %s %j", (cmd, args) => {
    expect(policyCallRefusal(policy, "os.shell.run", { cmd, args })).toContain("metadata is reserved");
  });
  it.each([
    ["env", ["FIXTURE=x", "echo", "-i"]], ["echo", ["env", "-i"]],
    ["env", ["-u", "FIXTURE", "echo"]], ["env", ["-ui", "echo"]],
  ] as const)("does not reinterpret ordinary data or unrelated unsets: %s %j", (cmd, args) => {
    expect(policyCallRefusal(policy, "os.shell.run", { cmd, args })).toBeNull();
  });
});
