import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installPolicy } from "../../../policy/policy-active.js";
import { ApprovalGate } from "../../../approval/approval-gate.js";
import { buildOsGitPullTool } from "./git-pull.js";
import * as runner from "./git-runner.js";

afterEach(() => { installPolicy(null); vi.restoreAllMocks(); });
describe("pull fetches then plans a pinned local integration", () => {
  it.each([false, true])("checks changed files before integration, rebase=%s", async rebase => {
    const root = mkdtempSync(join(tmpdir(), "policy-pull-plan-"));
    try {
      installPolicy({ sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "edit", resource: join(root, "blocked.txt"), effect: "deny" }] });
      let file = "ordinary.txt";
      const calls: string[][] = [];
      vi.spyOn(runner, "runGit").mockImplementation(async input => {
        calls.push(input.args);
        const stdout = input.args.includes("--show-toplevel") ? root : input.args[0] === "rev-parse" ? "a".repeat(40) : input.args[0] === "diff" ? file + "\0" : "";
        return { repoRoot: root, command: "fake", args: input.args, exitCode: 0, signal: null, stdout, stderr: "", durationMs: 0, timedOut: false, truncated: false, inputTruncated: false };
      });
      const tool = buildOsGitPullTool({ approvals: new ApprovalGate({ level: 5, emit: () => undefined }), approvalRequired: false, isRemoteSyncEnabled: () => true, urlDataGuard: "off", env: {} });
      const ctx = { workingDir: root, sessionId: "fixture", stepIndex: 0, signal: new AbortController().signal };
      expect((await tool.run({ branch: "fixture", rebase }, ctx)).status).toBe("ok");
      expect(calls.find(args => args[0] === (rebase ? "rebase" : "merge"))).toContain("a".repeat(40));
      file = "blocked.txt"; calls.length = 0;
      await expect(tool.run({ branch: "fixture", rebase }, ctx)).rejects.toThrow(/policy/);
      expect(calls.some(args => ["merge", "rebase", "pull"].includes(args[0] ?? ""))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
