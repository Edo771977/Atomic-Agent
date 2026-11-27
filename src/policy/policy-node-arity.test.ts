import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalGate } from "../approval/approval-gate.js";
import { analyzeShellRules } from "../tools/os/shell/org-shell-analysis.js";
import { interpreterScript } from "../tools/os/shell/org-script-operands.js";
import { evaluatePolicy, type EffectivePolicy } from "./policy-evaluator.js";
import { policyRuleMatch } from "./policy-enforce.js";
import { toolCallTarget } from "./policy-targets.js";

afterEach(() => vi.unstubAllEnvs());
const data = "data:text/javascript,void%200";
const valueFlags = ["--cpu-prof-dir", "--heap-prof-dir", "--cpu-prof-name", "--heap-prof-name", "--heapsnapshot-signal", "--report-signal", "--report-dir", "--report-filename", "--trace-event-categories", "--trace-event-file-pattern", "--watch-kill-signal", "--test-isolation", "--test-reporter-destination", "--diagnostic-dir"];
const loaders = ["--require", "--import", "--loader", "--experimental-loader", "--experimental_loader", "--test-reporter", "--test_reporter"];
const opaque = [
  ...loaders.flatMap(flag => [[flag, data, "fixture_file.js"], [`${flag}=${data}`, "fixture_file.js"]]),
  ...["--input-type", "--input_type"].flatMap(flag => [[flag, "module", "-"], [`${flag}=module`, "-"]]),
  ...valueFlags.flatMap(flag => [[flag, "fixture_value", "-"], [flag.replaceAll("-", "_").replace(/^__/, "--"), "fixture_value", "-"]]),
  ["--fixture-future", "fixture_value"], ["--fixture_future", "fixture_file.js"],
];
const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;
const forms = ["argv", "line", "verify", "node-options", "verify-env"] as const;
function inspect(args: string[], form: typeof forms[number]) {
  vi.stubEnv("NODE_OPTIONS", undefined);
  if (form === "verify" || form === "verify-env") {
    const env = form === "verify-env" ? { NODE_OPTIONS: args.slice(0, -1).map(quote).join(" ") } : undefined;
    return toolCallTarget("verify.run", { kind: "command", cmd: "node", args: env ? args.slice(-1) : args, stdin: "fixture-input", cwd: "/work", ...(env ? { env } : {}) })!;
  }
  const line = form === "node-options"
    ? `printf fixture | NODE_OPTIONS=${quote(args.slice(0, -1).map(quote).join(" "))} node ${quote(args.at(-1)!)}`
    : `printf fixture | node ${args.map(quote).join(" ")}`;
  const analysis = form === "argv" ? analyzeShellRules("node", args, false, "posix", "/work", true) : analyzeShellRules(line, [], true, "posix", "/work");
  return { action: "shell" as const, resources: analysis.segments.map(words => words.join(" ")), unreadable: analysis.unreadable };
}

describe("organization Node option names and stdin arity", () => {
  for (const level of [1, 5] as const) for (const effect of ["deny", "ask"] as const) {
    const policy: EffectivePolicy = { sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "shell", resource: "unrelated-fixture*", effect }] };
    for (const form of forms) it.each(opaque)(`${effect}/${level}/${form} covers %j`, async (...args) => {
      const target = inspect(args, form);
      expect(evaluatePolicy(policy, "shell", target.resources, target)?.effect).toBe(effect);
      let prompts = 0;
      const gate = new ApprovalGate({ level, emit: req => { prompts++; gate.reject(req.approvalId, "fixture declines"); } });
      gate.setOrgPolicy(req => policyRuleMatch(policy, req));
      const req = { tool: form.startsWith("verify") ? "verify.run" : "os.shell.run", category: "shell" as const, sessionId: "fixture", reason: "fixture", commandSegments: [["node", "fixture_file.js"]], commandUnreadable: target.unreadable };
      expect(gate.ruleDecisionFor(req)).toBe(effect);
      expect((await gate.request(req)).approved).toBe(false);
      expect(prompts).toBe(effect === "ask" ? 1 : 0);
    });
    it.each(valueFlags)(`${effect}/${level} preserves separate values and later script arguments: %s`, flag => {
      for (const spelling of [flag, flag.replaceAll("-", "_").replace(/^__/, "--")]) {
        const args = [spelling, "fixture_value_with_underscores", "fixture_file_with_underscores.js", "--eval", "ordinary_argument"];
        const script = interpreterScript(["node", ...args], "/work", "organization", true);
        expect(script).toEqual({ kind: "file", operand: "fixture_file_with_underscores.js" });
        const target = toolCallTarget("verify.run", { cmd: "node", args, stdin: "fixture-input" })!;
        expect(evaluatePolicy(policy, "shell", target.resources, target)).toBeNull();
      }
    });
    it.each([
      ["--fixture-future=fixture_value", "fixture_file.js"],
      ["--fixture-future", "--", "fixture_file.js"],
      ["fixture_file.js", "--fixture-future", "fixture_value"],
      ["--cpu-prof", "fixture_file.js"], ["--heap-prof", "fixture_file.js"], ["--experimental_vm_modules", "fixture_file.js"],
    ])(`${effect}/${level} retains identified files with stdin data: %j`, (...args) => {
      const target = inspect(args, "verify");
      expect(evaluatePolicy(policy, "shell", target.resources, target)).toBeNull();
    });
  }
  it("keeps unknown operational options readable without supplied stdin", () => {
    expect(analyzeShellRules("node", ["--fixture-future", "fixture_value"], false).unreadable).toBe(false);
    expect(interpreterScript(["node", "--fixture-future", "fixture_value"], "/work", "organization", true)?.kind).toBe("unknown");
  });
  it("normalizes names without changing inline values or file operands", () => {
    expect(interpreterScript(["node", "--experimental_loader=fixture_module_with_underscores", "fixture_file_with_underscores.js"])).toEqual({ kind: "file", operand: "fixture_file_with_underscores.js" });
    expect(interpreterScript(["node", "--report_dir", "fixture_dir_with_underscores", "fixture_file.js"])).toEqual({ kind: "file", operand: "fixture_file.js" });
  });
});
