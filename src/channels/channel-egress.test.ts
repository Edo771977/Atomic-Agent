import { describe, expect, it, vi } from "vitest";

import type { ApprovalRequest } from "../approval/approval-gate.js";
import { APPROVAL_DETAILS_WITHHELD, channelSendWithheld, gateApprovalHandler } from "./channel-egress.js";

const request: ApprovalRequest = {
  approvalId: "a1",
  sessionId: "s1",
  tool: "os.shell.run",
  category: "shell",
  reason: "writes /clienti/acme/out.csv",
  preview: "echo 'acme revenue 1.2M' > /clienti/acme/out.csv",
  affectedResources: ["/clienti/acme/out.csv"],
  commandShape: "echo",
  commandArgv: ["echo", "acme revenue 1.2M"],
  workdir: "/clienti/acme",
};

describe("chat egress for a constrained session (issue #33)", () => {
  it("an approval prompt for a restricted session carries the tool and kind only", () => {
    const seen: ApprovalRequest[] = [];
    const handler = gateApprovalHandler({ channelSendRefusal: () => "folder /clienti/acme is restricted" }, "s1", (r) => seen.push(r));
    handler(request);
    expect(seen).toEqual([{ approvalId: "a1", sessionId: "s1", tool: "os.shell.run", category: "shell", reason: APPROVAL_DETAILS_WITHHELD }]);
    expect(JSON.stringify(seen)).not.toContain("acme");
  });

  it("asks at each prompt, so an allowed session's prompt is passed on whole", () => {
    let refused: string | null = null;
    const seen: ApprovalRequest[] = [];
    const handler = gateApprovalHandler({ channelSendRefusal: () => refused }, "s1", (r) => seen.push(r));
    handler(request);
    refused = "tainted";
    handler(request);
    expect(seen[0]).toBe(request);
    expect(seen[1]?.preview).toBeUndefined();
  });

  it("a throwing check withholds; a runtime without the check allows", () => {
    expect(channelSendWithheld({ channelSendRefusal: () => { throw new Error("store closed"); } }, "s1")()).toBe(true);
    expect(channelSendWithheld({}, "s1")()).toBe(false);
    const check = vi.fn(() => null);
    expect(channelSendWithheld({ channelSendRefusal: check }, "s9")()).toBe(false);
    expect(check).toHaveBeenCalledWith("s9");
  });
});
