import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPolicy } from "../../../policy/policy-active.js";
import { ApprovalGate } from "../../../approval/approval-gate.js";
import { buildOsGitCloneTool } from "./git-clone.js";
import { buildOsGitFetchTool } from "./git-fetch.js";
import { buildOsGitPullTool } from "./git-pull.js";
import * as runner from "./git-runner.js";
const url = "https://fixture.test/restricted";
afterEach(() => { installPolicy(null); vi.restoreAllMocks(); });
describe("organization policy before Git network transports", () => {
  it.each(["clone", "fetch", "pull", "fetch-all"])("checks resolved URLs for %s with a fake Git adapter", async kind => {
    const root = mkdtempSync(join(tmpdir(), "policy-remote-"));
    try {
      installPolicy({ sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "webfetch", resource: "fixture.test", effect: "deny" }] });
      const calls: string[][] = [];
      vi.spyOn(runner, "runGit").mockImplementation(async input => {
        calls.push(input.args);
        const stdout = input.args[0] === "rev-parse" ? root : input.args[0] === "remote" && input.args.length === 1 ? "origin\nsecond\n" : input.args.includes("--get-url") || input.args.includes("get-url") ? url : "";
        return { repoRoot: root, command: "fake-git", args: input.args, exitCode: 0, signal: null, stdout, stderr: "", durationMs: 0, timedOut: false, truncated: false, inputTruncated: false };
      });
      const options = { approvals: new ApprovalGate({ level: 5, emit: () => undefined }), approvalRequired: false, isRemoteSyncEnabled: () => true, env: {} };
      const tool = kind === "clone" ? buildOsGitCloneTool(options) : kind === "pull" ? buildOsGitPullTool(options) : buildOsGitFetchTool(options);
      await tool.run({ url, dest: join(root, "new-repo"), all: kind === "fetch-all" }, { workingDir: root, sessionId: "fixture", stepIndex: 0, signal: new AbortController().signal }).catch(() => undefined);
      expect(calls.some(args => ["clone", "fetch", "pull"].some(verb => args.includes(verb)))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
