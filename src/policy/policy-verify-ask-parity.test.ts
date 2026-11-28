import { afterEach, describe, expect, it } from "vitest";
import { ApprovalGate } from "../approval/approval-gate.js";
import { authorizeVerifyBatch } from "../tools/verify/verify-authorization.js";
import { installPolicy } from "./policy-active.js";
import { policyRuleMatch } from "./policy-enforce.js";

afterEach(() => installPolicy(null));
describe("conservative organization ask survives personal parser parity in verify", () => {
  it.each([false, true])("requires the gate for an opaque native conditional, approvalRequired=%s", async approvalRequired => {
    const policy = { sources: [], mcpAllowlists: [], rules: [{ source: "system" as const, index: 0, action: "shell" as const, resource: "unrelated-fixture*", effect: "ask" as const }] };
    installPolicy(policy);
    let asked = 0;
    const gate = new ApprovalGate({ level: 5, emit: req => { asked++; gate.reject(req.approvalId, "fixture declines"); } });
    gate.setOrgPolicy(request => policyRuleMatch(policy, request)); gate.fanoutScopes.grant("fixture", [process.cwd()]);
    const cmd = process.platform === "win32" ? "if exist . echo fixture" : "fixture() { echo fixture; }; fixture";
    await expect(authorizeVerifyBatch([{ kind: "command", cmd }], { approvals: gate, approvalRequired, allowFanoutScope: true }, {
      sessionId: "fixture", workingDir: process.cwd(), stepIndex: 0, signal: new AbortController().signal,
    })).rejects.toMatchObject({ name: "ApprovalDeniedError" });
    expect(asked).toBe(1);
  });
});
