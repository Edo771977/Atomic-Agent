import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installPolicy } from "../../../policy/policy-active.js";
import { ApprovalGate } from "../../../approval/approval-gate.js";
import * as runner from "./git-runner.js";
import * as probe from "./git-repo-probe.js";
import { buildOsGitAddTool } from "./git-add.js";
import { buildOsGitCommitTool } from "./git-commit.js";

afterEach(() => { installPolicy(null); vi.restoreAllMocks(); });
describe("actual Git index plans", () => {
  it.each(["add", "commit"] as const)("checks staged/selected files rather than the root for %s", async verb => {
    const root = mkdtempSync(join(tmpdir(), "policy-index-"));
    try {
      installPolicy({ sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "edit", resource: join(root, "blocked.txt"), effect: "deny" }] });
      vi.spyOn(probe, "resolveGitToplevel").mockResolvedValue({ ok: true, root });
      vi.spyOn(probe, "hasHeadCommit").mockResolvedValue(true);
      let file = "ordinary.txt";
      const calls: string[][] = [];
      vi.spyOn(runner, "runGit").mockImplementation(async options => {
        calls.push(options.args);
        return { repoRoot: root, command: "fake", args: options.args, exitCode: 0, signal: null, stdout: options.args[0] === "diff" ? file + "\0" : "", stderr: "", durationMs: 0, timedOut: false, truncated: false, inputTruncated: false };
      });
      const options = { approvals: new ApprovalGate({ level: 5, emit: () => undefined }), approvalRequired: false };
      const tool = verb === "add" ? buildOsGitAddTool(options) : buildOsGitCommitTool(options);
      const args = verb === "add" ? { all: true } : { message: "fixture" };
      const ctx = { workingDir: root, sessionId: "fixture", stepIndex: 0, signal: new AbortController().signal };
      expect((await tool.run(args, ctx)).status).toBe("ok");
      file = "blocked.txt"; calls.length = 0;
      await expect(tool.run(args, ctx)).rejects.toThrow(/policy/);
      expect(calls.some(args => args[0] === "add" || args.includes("commit"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
