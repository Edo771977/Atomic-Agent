import { describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import { globMatches } from "./policy-glob.js";
import { evaluatePolicy, type EffectivePolicy } from "./policy-evaluator.js";

describe("bounded policy wildcard decisions", () => {
  it.each(["deny", "ask"] as const)("oversized benign resources remain unreadable for %s", effect => {
    const policy: EffectivePolicy = { rules: [{ source: "system", index: 0, action: "websearch", resource: "restricted topic", effect }], sources: [], mcpAllowlists: [] };
    expect(evaluatePolicy(policy, "websearch", ["ordinary ".repeat(20_000)])?.effect).toBe(effect);
  });
  it("matches a benign 100 KB path below 50 ms without regular expressions", () => {
    const path = `docs/${"a".repeat(100_000)}.txt`;
    const start = performance.now();
    expect(globMatches("docs/*.txt", path)).toBe(true);
    expect(performance.now() - start).toBeLessThan(50);
    expect(globMatches("docs/??.txt", path)).toBe(false);
  });
});
