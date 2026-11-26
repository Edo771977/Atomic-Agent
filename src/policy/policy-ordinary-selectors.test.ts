import { describe, expect, it } from "vitest";
import { analyzeShellRules } from "../tools/os/shell/org-shell-analysis.js";
import { policyRuleMatch } from "./policy-enforce.js";
import type { EffectivePolicy } from "./policy-evaluator.js";

const ordinary: Array<[string, string[]]> = [
  ["make", []], ["make", ["-j4"]], ["make", ["-j", "4", "build"]], ["gmake", ["build"]],
  ["node", ["--expose-gc", "fixture.js"]], ["node", ["--no-deprecation", "fixture.js"]],
  ["node", ["--trace-uncaught", "fixture.js"]], ["node", ["--max-old-space-size=128", "fixture.js"]],
  ["node", ["--stack-trace-limit=20", "fixture.js"]], ["node", ["--experimental-strip-types", "fixture.ts"]],
  ["sed", ["-n", "{s/a/b/;p;}", "fixture.txt"]], ["sed", ["1,3 { s/a/b/; p; }", "fixture.txt"]],
  ["sed", ["/a/ { p; }", "fixture.txt"]],
  ["awk", ['BEGIN { if (1 || 0) print "fixture" }']], ["awk", ["/a|b/ { print $0 }", "fixture.txt"]],
  ["awk", ['BEGIN { print "a|b" }']], ["awk", ["BEGIN { print 10 / 2 / 5 }"]],
];
const external: Array<[string, string[]]> = [
  ["make", ["--eval=all:;@fixture"]], ["make", ["-f", "-"]], ["make", ["SHELL=fixture"]],
  ["node", ["--eval", "void 0"]], ["node", ["--fixture-unknown", "fixture.js"]],
  ["node", ["--import=data:text/javascript,void 0", "fixture.js"]],
  ["sed", ["{1e fixture;}"]], ["sed", ["{s/a/b/e;}"]],
  ["awk", ['BEGIN { system("fixture") }']], ["awk", ['{ print $0 | "fixture" }']],
  ["awk", ['BEGIN { print 10 / system("fixture") / 2 }']], ["awk", ['{ "fixture" | getline item }']],
];
function decision(cmd: string, args: string[], useShell = false) {
  const policy: EffectivePolicy = { sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "shell", resource: "unrelated-fixture*", effect: "deny" }] };
  const analysis = analyzeShellRules(cmd, args, useShell, "posix");
  return policyRuleMatch(policy, { tool: "os.shell.run", category: "shell", commandSegments: analysis.segments, commandUnreadable: analysis.unreadable });
}
describe("ordinary selectors under an organization deny", () => {
  it.each(ordinary)("retains ordinary %s %j", (cmd, args) => expect(decision(cmd, args)).toBeNull());
  it("retains POSIX file inclusion", () => expect(decision(". ./fixture.sh", [], true)).toBeNull());
  it.each(external)("keeps external or indeterminate code restrictive: %s %j", (cmd, args) => expect(decision(cmd, args)?.decision).toBe("deny"));
});
