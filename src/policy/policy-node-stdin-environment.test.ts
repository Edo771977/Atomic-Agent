import { describe, expect, it } from "vitest";
import { toolCallTarget } from "./policy-targets.js";
import { evaluatePolicy, type EffectivePolicy } from "./policy-evaluator.js";

describe("Node options inherited by a verification shell's stdin body", () => {
  it.each(["--experimental_loader=data:text/javascript,void%200", "--test_reporter=data:text/javascript,void%200", "--input_type=module"])("retains %s across the stdin shell boundary", option => {
    const body = option.startsWith("--input") ? "node -" : "node fixture_file.js";
    for (const args of [["-s"], ["-c", "bash -s"]]) {
      const target = toolCallTarget("verify.run", { cmd: "bash", args, env: { NODE_OPTIONS: option }, stdin: body })!;
      for (const effect of ["deny", "ask"] as const) {
        const policy: EffectivePolicy = { sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "shell", resource: "unrelated-fixture*", effect }] };
        expect(evaluatePolicy(policy, "shell", target.resources, target)?.effect).toBe(effect);
      }
      expect(target.resources).toContain(body);
    }
  });
});
