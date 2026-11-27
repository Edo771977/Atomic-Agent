import { describe, expect, it } from "vitest";
import { ApprovalGate } from "../approval/approval-gate.js";
import { policyRuleMatch } from "./policy-enforce.js";
import type { EffectivePolicy } from "./policy-evaluator.js";
import { interpreterScript } from "../tools/os/shell/org-script-operands.js";

const flags = [
  "--check", "--test", "--watch", "--trace-warnings", "--trace-deprecation", "--no-warnings", "--enable-source-maps", "--use-strict", "--pending-deprecation", "--expose-gc", "--no-deprecation", "--trace-uncaught", "--abort-on-uncaught-exception", "--experimental-strip-types", "--no-experimental-strip-types", "--experimental-vm-modules", "--preserve-symlinks", "--preserve-symlinks-main", "--test-only", "--permission", "--experimental-permission", "--experimental-require-module", "--no-experimental-require-module", "--no-addons", "--inspect", "--inspect-brk", "--cpu-prof", "--heap-prof", "--experimental-test-coverage", "--throw-deprecation", "--trace-exit", "--trace-sigint", "--experimental-detect-module", "--harmony", "--frozen-intrinsics", "--no-experimental-fetch", "--zero-fill-buffers", "--watch-preserve-output", "--openssl-legacy-provider", "--experimental-sqlite", "--fixture-future-operational",
];
const values = ["--require", "--import", "--input-type", "--loader", "--experimental-loader", "--conditions", "--inspect-port", "--title", "--icu-data-dir", "--openssl-config", "--redirect-warnings", "--report-directory", "--report-filename", "--diagnostic-dir", "--unhandled-rejections", "--test-name-pattern", "--test-skip-pattern", "--test-concurrency", "--test-reporter", "--test-reporter-destination", "--test-shard", "--test-timeout", "--max-old-space-size", "--stack-trace-limit", "--stack-size", "--stack_size", "--env-file", "--env-file-if-exists", "--watch-path", "--disable-warning", "--dns-result-order", "--localstorage-file", "--allow-fs-read", "--allow-fs-write", "--max-semi-space-size", "--max-http-header-size", "--secure-heap", "--experimental-default-type", "--snapshot-blob"];
const ordinary = [
  ...flags.map(flag => [flag, "fixture.js"]),
  ...values.flatMap(flag => [[flag, "fixture", "fixture.js", "-e"], [`${flag}=fixture`, "fixture.js"]]),
  ["-r", "fixture.cjs", "fixture.js"], ["-rfixture.cjs", "fixture.js"],
  ["-C", "fixture", "fixture.js"], ["-Cfixture", "fixture.js"], ["--no-warnings=fixture", "fixture.js"],
  ["--run", "fixture", "-e", "data"], ["--run=fixture"],
];
const opaque = [
  ["-e", "void 0"], ["-p", "fixture"], ["-pe", "fixture"], ["--eval=void 0"], ["--print", "fixture"],
  ...["-r", "--require", "--import", "--loader", "--experimental-loader"].flatMap(flag => [[flag, "data:text/javascript,void 0", "fixture.js"], [flag.startsWith("--") ? `${flag}=data:text/javascript,void 0` : `${flag}data:text/javascript,void 0`, "fixture.js"]]),
  ["--input-type", "module"], ["--input-type=module", "-"], ["-i"], ["--interactive", "-"],
  ...values.map(flag => [flag, "fixture", "-e", "void 0"]),
];

describe("Node operational options use a code selector denylist", () => {
  for (const level of [1, 5] as const) for (const effect of ["deny", "ask"] as const) {
    const policy: EffectivePolicy = { sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "shell", resource: "unrelated-fixture*", effect }] };
    it.each(ordinary)(`${effect}/${level} leaves operational %j readable`, async (...args) => {
      const gate = new ApprovalGate({ level, emit: () => { throw new Error("ordinary call must not prompt for unrelated policy"); } });
      gate.setOrgPolicy(req => policyRuleMatch(policy, req));
      expect(gate.ruleDecisionFor({ tool: "os.shell.run", category: "shell", sessionId: "fixture", commandArgv: ["node", ...args] })).toBeNull();
    });
    it.each(opaque)(`${effect}/${level} gates code %j`, async (...args) => {
      let prompts = 0;
      const gate = new ApprovalGate({ level, emit: req => { prompts++; gate.reject(req.approvalId, "fixture declines"); } });
      gate.setOrgPolicy(req => policyRuleMatch(policy, req));
      const req = { tool: "os.shell.run", category: "shell" as const, sessionId: "fixture", reason: "fixture", commandArgv: ["node", ...args] };
      expect(gate.ruleDecisionFor(req)).toBe(effect);
      expect((await gate.request(req)).approved).toBe(false);
      expect(prompts).toBe(effect === "ask" ? 1 : 0);
    });
  }
  it("run selects no JavaScript input, including attached values", () => {
    expect(interpreterScript(["node", "--run", "fixture"])).toEqual({ kind: "none" });
    expect(interpreterScript(["node", "--run=fixture"])).toEqual({ kind: "none" });
  });
});
