import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPolicy } from "../../../policy/policy-active.js";
import { ApprovalGate } from "../../../approval/approval-gate.js";
import { buildOsGitCloneTool } from "./git-clone.js";
import { buildOsGitFetchTool } from "./git-fetch.js";
import { buildOsGitPullTool } from "./git-pull.js";
import { buildOsGitPushTool } from "./git-push.js";
import * as runner from "./git-runner.js";
afterEach(() => { installPolicy(null); vi.restoreAllMocks(); });
describe("Git network commands retain local mutation policy", () => {
  it.each(["clone", "fetch", "pull", "push"])("%s refuses before its fake network write", async kind => {
    const root = mkdtempSync(join(tmpdir(), "policy-git-write-"));
    try {
      installPolicy({ sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "edit", resource: "*", effect: "deny" }] });
      const calls: string[][] = [];
      vi.spyOn(runner, "runGit").mockImplementation(async input => {
        calls.push(input.args);
        return { repoRoot: root, command: "fake-git", args: input.args, exitCode: 0, signal: null, stdout: input.args.includes("get-url") ? "https://fixture.test/repo" : root, stderr: "", durationMs: 0, timedOut: false, truncated: false, inputTruncated: false };
      });
      const options = { approvals: new ApprovalGate({ level: 5, emit: () => undefined }), approvalRequired: false, isRemoteSyncEnabled: () => true, env: {} };
      const tool = kind === "clone" ? buildOsGitCloneTool(options) : kind === "pull" ? buildOsGitPullTool(options) : kind === "push" ? buildOsGitPushTool(options) : buildOsGitFetchTool(options);
      await tool.run({ url: "https://fixture.test/repo", dest: join(root, "new"), branch: "fixture", setUpstream: false }, { workingDir: root, sessionId: "fixture", stepIndex: 0, signal: new AbortController().signal }).catch(() => undefined);
      expect(calls.some(args => args.includes(kind))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
