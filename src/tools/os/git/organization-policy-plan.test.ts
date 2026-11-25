import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installPolicy } from "../../../policy/policy-active.js";
import { ApprovalGate } from "../../../approval/approval-gate.js";
import { buildOsGitCheckoutTool } from "./git-checkout.js";
import * as probe from "./git-repo-probe.js";
import * as runner from "./git-runner.js";
afterEach(() => { installPolicy(null); vi.restoreAllMocks(); });
describe("Git mutation plan policy", () => {
  it.each(["ordinary.txt", "blocked.txt"])("evaluates the actual checkout list: %s", async file => {
    const root = mkdtempSync(join(tmpdir(), "policy-git-plan-"));
    try {
      installPolicy({ sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "edit", resource: join(root, "blocked.txt").replace(/\\/g, "/"), effect: "deny" }] });
      vi.spyOn(probe, "resolveGitToplevel").mockResolvedValue({ ok: true, root });
      const calls: string[][] = [];
      vi.spyOn(runner, "runGit").mockImplementation(async options => {
        calls.push(options.args);
        return { repoRoot: root, command: "fake-git", args: options.args, exitCode: 0, signal: null, stdout: options.args[0] === "diff" ? `${file}\0` : "", stderr: "", durationMs: 0, timedOut: false, truncated: false, inputTruncated: false };
      });
      const gate = new ApprovalGate({ level: 5, emit: () => undefined });
      const result = buildOsGitCheckoutTool({ approvals: gate, approvalRequired: false }).run({ branch: "fixture" }, { workingDir: root, sessionId: "fixture", stepIndex: 0, signal: new AbortController().signal });
      if (file === "blocked.txt") { await expect(result).rejects.toThrow(/policy/); expect(calls.some(args => args[0] === "checkout")).toBe(false); }
      else { expect((await result).status).toBe("ok"); expect(calls.some(args => args[0] === "checkout")).toBe(true); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
