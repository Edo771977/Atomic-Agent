import { describe, expect, it } from "vitest";

import type { ApprovalRequest } from "../approval/approval-gate.js";
import { approvalForServe, isNetworkListenHost, serveWithheld } from "./serve-egress.js";

describe("serve egress (issue #33)", () => {
  it("only loopback names and addresses stay on this machine", () => {
    for (const host of ["127.0.0.1", "localhost", "::1", "[::1]"]) expect(isNetworkListenHost(host)).toBe(false);
    for (const host of ["0.0.0.0", "::", "192.168.1.5", "my-laptop"]) expect(isNetworkListenHost(host)).toBe(true);
  });

  it("withholds only on a network server, and fails closed when the check throws", () => {
    const refusing = { runtime: { serveRefusal: () => "restricted" } } as never;
    expect(serveWithheld({ ...(refusing as object), networkServe: false } as never, "s")()).toBe(false);
    expect(serveWithheld({ ...(refusing as object), networkServe: true } as never, "s")()).toBe(true);
    const throwing = { networkServe: true, runtime: { serveRefusal: () => { throw new Error("closed"); } } } as never;
    expect(serveWithheld(throwing, "s")()).toBe(true);
  });

  it("an approval on /api/events loses its preview for a restricted session on a network server", () => {
    const request: ApprovalRequest = { approvalId: "a", sessionId: "s", tool: "os.shell.run", category: "shell", reason: "acme", preview: "cat /clienti/acme/bilancio.csv" };
    const ctx = { networkServe: true, runtime: { serveRefusal: () => "restricted" } } as never;
    expect(JSON.stringify(approvalForServe(ctx, request))).not.toContain("acme");
    const loopback = { networkServe: false, runtime: { serveRefusal: () => "restricted" } } as never;
    expect(approvalForServe(loopback, request)).toBe(request);
  });
});
