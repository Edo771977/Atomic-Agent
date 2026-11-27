import { describe, expect, it } from "vitest";
import { shellRuleSegments, shellRunsUnreadableScript } from "../tools/os/shell/shell-command-argv.js";
import { matchRules } from "../approval/approval-rules.js";
import { evaluatePolicy, type EffectivePolicy } from "./policy-evaluator.js";
import { toolCallTarget } from "./policy-targets.js";

const ordinary: Array<[string, ...string[]]> = [
  ["python3", "-W", "error", "-X", "utf8", "fixture.py", "-c", "data"],
  ["python3", "-m", "fixture_module", "-c", "data"],
  ["python3", "--", "fixture.py", "-cdata"],
  ["node", "--require", "fixture.cjs", "fixture.js", "--eval=data"],
  ["node", "--check", "fixture.js"],
  ["node", "--future-fixture-option", "fixture", "-e", "void 0"],
  ["node", "--", "fixture.js", "-e", "data"],
  ["perl", "-Mstrict", "fixture.pl", "-e1"],
  ["perl", "-Mfeature", "fixture.pl"],
  ["perl", "-I/fixture", "fixture.pl"],
  ["ruby", "-rdelegate", "fixture.rb"],
  ["ruby", "-E", "UTF-8", "fixture.rb"],
  ["ruby", "-r", "fixture", "fixture.rb", "-e1"],
  ["sed", "-n", "-e", "s/a/b/p", "fixture.txt"],
  ["awk", "{ print $1 }", "fixture.txt"],
  ["source", "/fixture/ordinary.sh", "-e"],
];
const inline: Array<[string, ...string[]]> = [
  ["python3", "-W", "error", "-c", "pass"],
  ["python3", "--check-hash-based-pycs", "always", "-c", "pass"],
  ["node", "--title", "fixture", "-e", "void 0"],
  ["ruby", "--encoding", "UTF-8", "-e1"],
  ["node", "--require", "fixture.cjs", "-e", "void 0"],
  ["perl", "-I", "/fixture", "-we1"],
  ["ruby", "-I", "/fixture", "-e1"],
  ["sed", "-e", "e fixture"],
  ["sed", "-e", "1e fixture"],
  ["awk", "BEGIN { system(\"fixture\") }"],
  ["awk", "--source=BEGIN { system(\"fixture\") }"],
  ["sed", "-f", "fixture.sed", "-e", "e fixture"],
];

describe("personal rules retain main interpreter decisions independently of organization analysis", () => {
  it.each([["node.exe", "fixture"], ["node", "\0"]])("keeps main's literal saved-prefix identity for %j", (...words) => {
    const match = matchRules([{ id: "fixture", source: "user", createdAt: "", category: "shell", decision: "deny", commandPrefix: ["node", "fixture"] }], {
      tool: "os.shell.run", category: "shell", commandSegments: [words],
    });
    expect(match).toBeNull();
  });
  it.each([...ordinary, ...inline])("does not broaden an unrelated saved rule for %j", (cmd, ...args) => {
    for (const decision of ["deny", "ask"] as const) {
      const match = matchRules([{ id: "fixture", source: "user", createdAt: "", category: "shell", commandPrefix: ["unrelated-fixture"], decision }], {
        tool: "os.shell.run", category: "shell", commandSegments: shellRuleSegments(cmd, args, false), commandUnreadable: shellRunsUnreadableScript(cmd, args, false),
      });
      expect(match).toBeNull();
    }
  });
  it.each(ordinary)("leaves ordinary file/module/DSL use readable for organization policy: %j", (cmd, ...args) => {
    const target = toolCallTarget("os.shell.run", { cmd, args })!;
    for (const effect of ["deny", "ask"] as const) {
      const policy: EffectivePolicy = { sources: [], mcpAllowlists: [], rules: [{ action: "shell", resource: "unrelated-fixture*", effect, source: "system", index: 0 }] };
      expect(evaluatePolicy(policy, "shell", target.resources, target)).toBeNull();
    }
  });
  it.each(inline)("retains conservative inline-code classification for organization policy: %j", (cmd, ...args) => {
    const target = toolCallTarget("os.shell.run", { cmd, args })!;
    for (const effect of ["deny", "ask"] as const) {
      const policy: EffectivePolicy = { sources: [], mcpAllowlists: [], rules: [{ action: "shell", resource: "unrelated-fixture*", effect, source: "system", index: 0 }] };
      expect(evaluatePolicy(policy, "shell", target.resources, target)?.effect).toBe(effect);
    }
  });
});
