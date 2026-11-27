import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalGate } from "../approval/approval-gate.js";
import { analyzeShellRules } from "../tools/os/shell/org-shell-analysis.js";
import { evaluatePolicy, type EffectivePolicy } from "./policy-evaluator.js";
import { policyRuleMatch } from "./policy-enforce.js";
import { toolCallTarget } from "./policy-targets.js";

afterEach(() => vi.unstubAllEnvs());
const ordinary = [
  "node --experimental-transform-types x.ts | tee log",
  "node --test --test-force-exit x.js 2>&1 | tail",
  "node --use-system-ca x.js || true",
  "node --trace-gc x.js | cat", "node --prof x.js | cat",
  "node --experimental-transform-types x.ts; ls | wc -l",
  'node --jitless x.js "a<b"', 'node --jitless x.js "a|b"',
  "for item in fixture; do node --trace-gc x.js | cat; done",
  "sh -c 'node --trace-gc x.js | cat'",
  // An unknown boolean proves routing separately from the known-option table.
  "node --fixture-boolean x.js | cat", "node --fixture-boolean x.js || true",
  "node --fixture-boolean x.js; ls | wc -l", "cat < fixture; node --fixture-boolean x.js",
  'node --fixture-boolean x.js "a<b" "a|b"',
  "node --fixture-boolean x.js 2>&1 | tail", "node --fixture-boolean x.js 2< fixture",
  "for item in fixture; do node --fixture-boolean x.js | cat; done",
  "sh -c 'node --fixture-boolean x.js | cat'",
  "(node --fixture-boolean x.js) | cat", "{ node --fixture-boolean x.js; } | cat",
  "sh -c 'node --fixture-boolean x.js; ls | wc -l'",
  "printf fixture | sh -c 'cat | node --fixture-boolean=value x.js'",
];
const incoming = [
  "printf fixture | node --fixture-boolean x.js",
  "node --fixture-boolean x.js < fixture", "node --fixture-boolean x.js 0< fixture",
  "node --fixture-boolean x.js <<< fixture", "node --fixture-boolean x.js <<EOF\nfixture\nEOF",
  "sh -c 'node --fixture-boolean x.js' < fixture",
  "printf fixture | sh -c 'node --fixture-boolean x.js | cat'",
  "(node --fixture-boolean x.js) < fixture",
  "{ node --fixture-boolean x.js; } < fixture",
  "for item in fixture; do node --fixture-boolean x.js | cat; done < fixture",
  "sh -c 'cat | node --fixture-boolean x.js'",
];
const booleans = ["--trace-gc", "--use-system-ca", "--jitless", "--prof", "--experimental-transform-types", "--test-force-exit", "--experimental-detect-module"];

describe("organization Node stdin follows the receiving command", () => {
  for (const level of [1, 5] as const) for (const effect of ["deny", "ask"] as const) {
    const policy: EffectivePolicy = { sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "shell", resource: "unrelated-fixture*", effect }] };
    const decide = (line: string) => {
      vi.stubEnv("NODE_OPTIONS", undefined);
      const analysis = analyzeShellRules(line, [], true, "posix", "/work");
      const target = { resources: analysis.segments.map(words => words.join(" ")), unreadable: analysis.unreadable };
      const request = { tool: "os.shell.run", category: "shell" as const, sessionId: "fixture", reason: "fixture", commandSegments: analysis.segments, commandUnreadable: analysis.unreadable };
      const gate = new ApprovalGate({ level, emit: () => {} });
      gate.setOrgPolicy(req => policyRuleMatch(policy, req));
      return [evaluatePolicy(policy, "shell", target.resources, target)?.effect ?? null, gate.ruleDecisionFor(request)];
    };
    it.each(ordinary)(`${effect}/${level} does not invent stdin: %s`, line => expect(decide(line)).toEqual([null, null]));
    it.each(incoming)(`${effect}/${level} retains ambiguous real input: %s`, async line => {
      expect(decide(line)).toEqual([effect, effect]);
      const analysis = analyzeShellRules(line, [], true, "posix", "/work");
      let prompts = 0;
      const gate = new ApprovalGate({ level, emit: req => { prompts++; gate.reject(req.approvalId, "fixture declines"); } });
      gate.setOrgPolicy(req => policyRuleMatch(policy, req));
      expect((await gate.request({ tool: "os.shell.run", category: "shell", sessionId: "fixture", reason: "fixture", commandSegments: analysis.segments, commandUnreadable: analysis.unreadable })).approved).toBe(false);
      expect(prompts).toBe(effect === "ask" ? 1 : 0);
    });
    it.each(booleans)(`${effect}/${level} recognizes boolean and its negation with real input: %s`, flag => {
      for (const spelling of [flag, `--no-${flag.slice(2)}`]) {
        expect(decide(`printf fixture | node ${spelling} x.js`)).toEqual([null, null]);
        const target = toolCallTarget("verify.run", { cmd: "node", args: [spelling, "x.js"], stdin: "fixture" })!;
        expect(evaluatePolicy(policy, "shell", target.resources, target)).toBeNull();
      }
    });
    it("retains unknown NODE_OPTIONS ambiguity only with actual input", () => {
      expect(decide("NODE_OPTIONS=--fixture-boolean node x.js | cat")).toEqual([null, null]);
      expect(decide("printf fixture | NODE_OPTIONS=--fixture-boolean node x.js")).toEqual([effect, effect]);
      expect(decide("printf fixture | NODE_OPTIONS=--fixture-boolean=value node x.js")).toEqual([null, null]);
      expect(decide("printf fixture | node --fixture-boolean -- x.js")).toEqual([null, null]);
    });
    it(`${effect}/${level} retains inherited input after reading a supplied shell script`, () => {
      for (const args of [["-s"], ["-c", "bash -s"]]) {
        const target = toolCallTarget("verify.run", { cmd: "bash", args, stdin: "node --fixture-boolean x.js" })!;
        expect(evaluatePolicy(policy, "shell", target.resources, target)?.effect).toBe(effect);
      }
    });
  }
});
