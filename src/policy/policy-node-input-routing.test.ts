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

function routingCases(family: string, lines: readonly string[], opaque = true, verifyInput = false) {
  describe(family, () => {
    for (const level of [1, 5] as const) for (const effect of ["deny", "ask"] as const) for (const surface of ["shell", "verify"] as const) {
      it.each(lines)(`${effect}/${level}/${surface}: %s`, async line => {
        vi.stubEnv("NODE_OPTIONS", undefined);
        const analysis = analyzeShellRules(line, [], true, "posix", "/work");
        const target = surface === "verify" ? toolCallTarget("verify.run", { cmd: "bash", args: ["-c", line], cwd: "/work", ...(verifyInput ? { stdin: "fixture" } : {}) })! : { resources: analysis.segments.map(words => words.join(" ")), unreadable: analysis.unreadable };
        const policy: EffectivePolicy = { sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "shell", resource: "unrelated-fixture*", effect }] };
        expect(evaluatePolicy(policy, "shell", target.resources, target)?.effect ?? null).toBe(opaque ? effect : null);
        let prompts = 0;
        const gate = new ApprovalGate({ level, emit: req => { prompts++; gate.reject(req.approvalId, "fixture declines"); } });
        gate.setOrgPolicy(req => policyRuleMatch(policy, req));
        const req = { tool: surface === "verify" ? "verify.run" : "os.shell.run", category: "shell" as const, sessionId: "fixture", reason: "fixture", commandSegments: analysis.segments, commandUnreadable: target.unreadable };
        expect(gate.ruleDecisionFor(req)).toBe(opaque ? effect : null);
        if (opaque) {
          expect((await gate.request(req)).approved).toBe(false);
          expect(prompts).toBe(effect === "ask" ? 1 : 0);
        }
      });
    }
  });
}

routingCases("R9 syntax belongs to command positions", [
  'printf fixture | { echo "}"; node --fixture-boolean x.js; }',
  "printf fixture | { echo \\}; node --fixture-boolean x.js; }",
  "printf fixture | for item in fixture; do 'done'; node --fixture-boolean x.js; done",
  "printf fixture | if true; then 'fi'; node --fixture-boolean x.js; fi",
  "printf fixture | if true; then \\fi; node --fixture-boolean x.js; fi",
  "printf fixture | { echo } done; node --fixture-boolean x.js; }",
  "printf fixture | case fixture in fixture) 'esac'; node --fixture-boolean x.js;; esac",
  "printf fixture | case fixture in fixture) \\esac; node --fixture-boolean x.js;; esac",
  "node --fixture-boolean x.js <", "printf fixture | ; node --fixture-boolean x.js",
  ") node --fixture-boolean x.js", "done; node --fixture-boolean x.js",
  "printf fixture |", "(node --fixture-boolean x.js",
]);

routingCases("R9 pipelines survive newlines and comments", [
  "printf fixture |\nnode --fixture-boolean x.js",
  "printf fixture |\n\nnode --fixture-boolean x.js",
  "printf fixture | # fixture\n# fixture\n\nnode --fixture-boolean x.js",
  "printf fixture |\n{ node --fixture-boolean x.js; }",
  "sh -c 'printf fixture |\n# fixture\nnode --fixture-boolean x.js'",
]);
routingCases("R9 outgoing multiline pipeline stays ordinary", [
  "node --fixture-boolean x.js |\n# fixture\ncat",
  "node --fixture-boolean x.js\nprintf fixture |\ncat",
], false);

routingCases("R9 exec keeps frame input and descriptor duplication", [
  "exec < fixture; node --fixture-boolean x.js",
  "exec 3< fixture; exec 0<&3; node --fixture-boolean x.js",
  "exec 3< fixture; exec 0>&3; node --fixture-boolean x.js",
  "exec < fixture; sh -c 'node --fixture-boolean x.js'",
  "{ exec < fixture; node --fixture-boolean x.js; }",
  "(exec < fixture; node --fixture-boolean x.js)",
]);
routingCases("R9 exec input stays inside its frame", [
  "(exec < fixture; cat); node --fixture-boolean x.js",
  "exec 3< fixture; node --fixture-boolean x.js",
], false);
routingCases("R9 exec prefixes and uncertain persistence", [
  "command exec < fixture; node --fixture-boolean x.js",
  "builtin exec < fixture; node --fixture-boolean x.js",
  "FIXTURE=value exec < fixture; node --fixture-boolean x.js",
  "exec < fixture | cat; node --fixture-boolean x.js",
  "printf fixture | exec < fixture; node --fixture-boolean x.js",
  "exec -a fixture < fixture; node --fixture-boolean x.js",
  "eval 'exec < fixture'; node --fixture-boolean x.js",
]);
routingCases("R9 literal exec prefixes preserve empty sources", [
  "command exec < /dev/null; node --fixture-boolean x.js",
  "FIXTURE=value exec < /dev/null; node --fixture-boolean x.js",
], false);

routingCases("R9 command substitutions inherit their owning input", [
  'printf fixture | echo "$(node --fixture-boolean x.js)"',
  'printf fixture | echo "`node --fixture-boolean x.js`"',
  'echo "$(node --fixture-boolean x.js)" < fixture',
  'exec < fixture; echo "$(node --fixture-boolean x.js)"',
  'printf fixture | { echo "$(node --fixture-boolean x.js)"; }',
  "printf fixture | cat <<EOF\n$(node --fixture-boolean x.js)\nEOF",
]);
routingCases("R9 command substitution output is not input", [
  'echo "$(node --fixture-boolean x.js)" | cat',
  'echo "`node --fixture-boolean x.js`" | cat',
  'cat < fixture; echo "$(node --fixture-boolean x.js)"',
  'echo "$(node --fixture-boolean x.js)"; printf fixture | cat',
], false);

routingCases("R9 process substitutions inherit input", [
  "printf fixture | cat <(node --fixture-boolean x.js)",
  "exec < fixture; cat <(node --fixture-boolean x.js)",
  "cat <(node --fixture-boolean x.js) < fixture",
  "printf fixture > >(node --fixture-boolean x.js)",
]);
routingCases("R9 process producer without input stays ordinary", [
  "cat <(node --fixture-boolean x.js) | cat",
  "cat < fixture; cat <(node --fixture-boolean x.js)",
], false);

const node25Values = ["--tls-cipher-list", "--tls-keylog", "--openssl-config", "--icu-data-dir", "--title", "--redirect-warnings", "--unhandled-rejections", "--max-old-space-size", "--stack-size", "--localstorage-file"];
const node25Booleans = ["--tls-min-v1.0", "--tls-min-v1.1", "--tls-min-v1.2", "--tls-min-v1.3", "--tls-max-v1.2", "--tls-max-v1.3"];
routingCases("R9 Node25 separated option values do not become scripts", node25Values.map(flag => `printf fixture | node ${flag} fixture -`));
routingCases("R9 Node25 booleans identify scripts with real input", node25Booleans.map(flag => `printf fixture | node ${flag} x.js`), false);
routingCases("R9 Node25 options preserve file and code boundaries", node25Values.map(flag => `printf fixture | node ${flag} fixture x.js`), false);
describe("R9 Node25 direct verification argv", () => {
  for (const level of [1, 5]) for (const effect of ["deny", "ask"] as const) {
    it.each(node25Values)(`${effect}/${level} consumes %s before stdin or code`, flag => {
      const policy: EffectivePolicy = { sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "shell", resource: "unrelated-fixture*", effect }] };
      for (const [operand, expected] of [["-", effect], ["x.js", null], ["-e", effect]] as const) {
        const target = toolCallTarget("verify.run", { cmd: "node", args: [flag, "fixture", operand, ...(operand === "-e" ? ["void 0"] : [])], stdin: "fixture" })!;
        expect(evaluatePolicy(policy, "shell", target.resources, target)?.effect ?? null).toBe(expected);
      }
    });
  }
});

routingCases("R9 known null input overrides inherited streams", [
  "node --fixture-boolean x.js < /dev/null",
  "printf fixture | node --fixture-boolean x.js < /dev/null",
  "exec < /dev/null; node --fixture-boolean x.js",
  "exec 3< /dev/null; exec 0<&3; node --fixture-boolean x.js",
  "sh -c 'node --fixture-boolean x.js' < /dev/null",
  "printf fixture | sh -c 'node --fixture-boolean x.js' < /dev/null",
  "exec < fixture; node --fixture-boolean x.js < /dev/null",
  'exec < /dev/null; echo "$(node --fixture-boolean x.js)"',
  "cat <(node --fixture-boolean x.js) < /dev/null",
], false, true);
routingCases("R9 real streams supersede known null input", [
  "exec < /dev/null; printf fixture | node --fixture-boolean x.js",
  "exec < /dev/null; exec < fixture; node --fixture-boolean x.js",
]);
routingCases("R9 unresolved nonzero descriptors across shells remain conservative", [
  "exec 3< /dev/null; sh -c 'exec 0<&3; node --fixture-boolean x.js'",
  "exec 3< /dev/null; sh -c 'node --fixture-boolean x.js <&3'",
]);
