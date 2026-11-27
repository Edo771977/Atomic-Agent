import { describe, expect, it } from "vitest";
import { toolCallTarget } from "./policy-targets.js";
import { evaluatePolicy, type EffectivePolicy } from "./policy-evaluator.js";

describe("organization wrapper script options", () => {
  it.each([
    ["env", "-Sfixture-block stop"], ["env", "--split-string=fixture-block stop"],
    ["env", "-S", "'fixture-block' 'stop now'"],
    ["npx", "--call=fixture-block stop"], ["npx", "-c", "fixture-block stop"],
    ["npm", "exec", "--call", "fixture-block stop"], ["npm", "exec", "-cfixture-block stop"],
  ])("checks nested code in %j", (cmd, ...args) => {
    const target = toolCallTarget("os.shell.run", { cmd, args })!;
    for (const effect of ["deny", "ask"] as const) {
      const p: EffectivePolicy = { sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "shell", resource: "fixture-block*", effect }] };
      expect(evaluatePolicy(p, "shell", target.resources, target)?.effect).toBe(effect);
    }
  });
  it("stops interpreting npm call flags at the operand boundary", () => {
    expect(toolCallTarget("os.shell.run", { cmd: "npm", args: ["exec", "--", "printf", "--call=fixture-block stop"] })?.resources).not.toContain("fixture-block stop");
  });
});
