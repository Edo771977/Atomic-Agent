import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ApprovalGate } from "../../../approval/approval-gate.js";
import { installPolicy } from "../../../policy/policy-active.js";
import { buildOsGitPullTool } from "./git-pull.js";
import * as runner from "./git-runner.js";
afterEach(() => { installPolicy(null); vi.restoreAllMocks(); });
describe("policy pull retains the configured upstream when branch is omitted", () => {
  it("fetches the configured source ref rather than selecting another FETCH_HEAD entry", async () => {
    const root = mkdtempSync(join(tmpdir(), "policy-pull-upstream-"));
    try {
      installPolicy({ sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "edit", resource: join(root, "unrelated.txt"), effect: "deny" }] });
      const calls: string[][] = [];
      let configuredRemote = "origin";
      vi.spyOn(runner, "runGit").mockImplementation(async input => {
        calls.push(input.args);
        const stdout = input.args.includes("--show-toplevel") ? root : input.args[0] === "symbolic-ref" ? "fixture-local" : input.args[0] === "config" ? input.args[2]?.endsWith(".remote") ? configuredRemote : "refs/heads/fixture-upstream" : input.args[0] === "rev-parse" ? "a".repeat(40) : "";
        return { repoRoot: root, command: "fake", args: input.args, exitCode: 0, signal: null, stdout, stderr: "", durationMs: 0, timedOut: false, truncated: false, inputTruncated: false };
      });
      const tool = buildOsGitPullTool({ approvals: new ApprovalGate({ level: 5, emit: () => undefined }), approvalRequired: false, isRemoteSyncEnabled: () => true, urlDataGuard: "off", env: {} });
      expect((await tool.run({}, { workingDir: root, sessionId: "fixture", stepIndex: 0, signal: new AbortController().signal })).status).toBe("ok");
      expect(calls.find(args => args[0] === "fetch")).toContain("refs/heads/fixture-upstream");
      configuredRemote = "other"; calls.length = 0;
      await expect(tool.run({}, { workingDir: root, sessionId: "fixture", stepIndex: 0, signal: new AbortController().signal })).rejects.toThrow(/configured pull remote/);
      expect(calls.some(args => args[0] === "fetch")).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
