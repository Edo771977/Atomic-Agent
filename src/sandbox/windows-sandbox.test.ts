import { describe, expect, it } from "vitest";
import { buildOsSandboxPolicy } from "./os-sandbox.js";
import { wrapWindowsSandbox } from "./windows-sandbox.js";

describe("Windows Safe Mode readiness", () => {
  it("refuses even an offline request while the native acceptance tests are blocked", () => {
    const cwd = process.cwd();
    const policy = buildOsSandboxPolicy({ workspaceRoots: [cwd], network: false });
    expect(wrapWindowsSandbox("node", ["-e", "console.log(1)"], policy, { cwd })).toEqual({
      ok: false, reason: expect.stringContaining("fails Winsock startup"),
    });
  });

  it("refuses one-time network requests before starting a helper", () => {
    const cwd = process.cwd();
    const policy = buildOsSandboxPolicy({ workspaceRoots: [cwd], network: true });
    expect(wrapWindowsSandbox("node", [], policy, { cwd })).toEqual({
      ok: false, reason: expect.stringContaining("including one-time requests"),
    });
  });
});
