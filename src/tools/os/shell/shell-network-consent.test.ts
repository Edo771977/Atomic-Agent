import { expect, it } from "vitest";
import { ApprovalGate } from "../../../approval/approval-gate.js";
import { buildOsShellTool } from "./shell.js";

it("review 8: one-time network consent describes host resources", async () => {
  let reason: string | undefined;
  const gate = new ApprovalGate({ emit: request => {
    if (request.oneShot) reason = request.reason;
    gate.resolve({ approvalId: request.approvalId, approved: !request.oneShot });
  } });
  const shell = buildOsShellTool({ approvals: gate, approvalRequired: true, sandbox: () => ({ mode: "workspace", network: true }) });
  await expect(shell.run({ cmd: "echo fixture", network: true }, {
    workingDir: process.cwd(), sessionId: "network-review", stepIndex: 0, signal: new AbortController().signal,
  })).rejects.toThrow();
  expect(reason).toContain("loopback");
  expect(reason).toContain("abstract Unix sockets");
});
