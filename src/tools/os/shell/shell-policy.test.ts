import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalGate } from "../../../approval/approval-gate.js";
import type { ApprovalCategory } from "../../../approval/approval-level.js";
import type { ToolContext } from "../../tool-registry.js";
import { buildOsShellTool } from "./shell.js";

function makeCtx(workingDir: string): ToolContext {
  return {
    workingDir,
    sessionId: "test-session",
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}

/**
 * The closed-repository switch through the escape hatch: `os.shell.run`
 * must refuse a network git verb before the approval gate is ever
 * consulted, and must stop refusing the moment the switch flips.
 */
describe("os.shell.run honours the git remote-sync policy", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-shell-policy-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses git push without asking for approval while remote sync is off", async () => {
    let prompts = 0;
    const gate = new ApprovalGate({
      emit: (req) => {
        prompts += 1;
        gate.resolve({ approvalId: req.approvalId, approved: true });
      },
    });
    const tool = buildOsShellTool({
      approvals: gate,
      approvalRequired: true,
      shellPolicy: { isGitRemoteSyncEnabled: () => false },
    });
    const result = await tool.run(
      { cmd: "git", args: ["push", "origin", "main"] },
      makeCtx(dir),
    );
    expect(result.status).toBe("error");
    expect(result.summary).toContain("remote sync is off");
    expect(result.details.guardVerdict).toBe("block");
    expect(result.details.guardRule).toBe("policy.git_remote_sync_off");
    expect(prompts).toBe(0);
  });

  it("refuses a pre-joined command line too (subshell path)", async () => {
    const gate = new ApprovalGate({ emit: () => undefined });
    const tool = buildOsShellTool({
      approvals: gate,
      approvalRequired: true,
      shellPolicy: { isGitRemoteSyncEnabled: () => false },
    });
    const result = await tool.run(
      { cmd: "git fetch --all && git pull", args: [] },
      makeCtx(dir),
    );
    expect(result.status).toBe("error");
    expect(result.details.guardRule).toBe("policy.git_remote_sync_off");
  });

  it.each([
    ["--url=docs.example/?q=first%0Asecond"],
    ["--get", "--data", "q=short", "docs.example"],
    ["-G", "--data-urlencode", "q@payload.txt", "https://docs.example/"],
    ["--url-query=q@payload.txt", "https://docs.example/"],
  ])("holds curl URL arguments %j without reading a data file", async (...args) => {
    const categories: string[] = [];
    const gate = new ApprovalGate({
      emit: (request) => {
        categories.push(request.category);
        if (request.category === "http_write") gate.reject(request.approvalId, "fixture refuses the URL");
        else gate.resolve({ approvalId: request.approvalId, approved: true });
      },
    });
    const tool = buildOsShellTool({ approvals: gate, approvalRequired: true });
    // The executable is never used on the red path either.
    const emptyPath = await mkdtemp(join(dir, "no-bin-"));
    const command = join(emptyPath, "curl");
    await expect(tool.run({ cmd: command, args }, makeCtx(dir))).rejects.toMatchObject({ name: "ApprovalDeniedError" });
    expect(categories.at(-1)).toBe("http_write");
  });

  it.each(["curl", "wget", "Invoke-WebRequest"])("holds a data-bearing URL in %s before spawn", async (cmd) => {
    const categories: ApprovalCategory[] = [];
    const gate = new ApprovalGate({
      emit: (request) => {
        categories.push(request.category);
        if (request.category === "http_write") gate.reject(request.approvalId, "fixture refuses the URL");
        else gate.resolve({ approvalId: request.approvalId, approved: true });
      },
    });
    const tool = buildOsShellTool({ approvals: gate, approvalRequired: true });
    const url = "https://docs.example/?q=first%0Asecond";
    await expect(tool.run({ cmd, args: [url] }, makeCtx(dir))).rejects.toMatchObject({ name: "ApprovalDeniedError" });
    expect(categories.at(-1)).toBe("http_write");
  });

  it("asks for approval as usual once remote sync is on", async () => {
    let prompts = 0;
    const gate = new ApprovalGate({
      emit: (req) => {
        prompts += 1;
        gate.reject(req.approvalId, "not now");
      },
    });
    const tool = buildOsShellTool({
      approvals: gate,
      approvalRequired: true,
      shellPolicy: { isGitRemoteSyncEnabled: () => true },
    });
    await expect(
      tool.run({ cmd: "git", args: ["push"] }, makeCtx(dir)),
    ).rejects.toMatchObject({ name: "ApprovalDeniedError" });
    expect(prompts).toBe(1);
  });
});

/**
 * ATO-1260: with the browser tool failing, a model drove Chrome through
 * `osascript` and `open -a`. The shell refuses before any approval, so
 * Bypass cannot run it either.
 */
describe("os.shell.run refuses to drive a web browser", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-shell-browser-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.each([
    [{ cmd: "osascript", args: ["-e", 'tell application "Google Chrome" to set URL of active tab of front window to "https://mail.google.com"'] }],
    [{ cmd: "open", args: ["-a", "Google Chrome", "https://mail.google.com/mail/u/0/"] }],
    [{ cmd: `osascript -e 'tell application "Google Chrome" to get {URL, title} of active tab of front window'` }],
  ])("%j is refused without asking", async (call) => {
    let prompts = 0;
    const gate = new ApprovalGate({
      emit: (req) => {
        prompts += 1;
        gate.resolve({ approvalId: req.approvalId, approved: true });
      },
    });
    const tool = buildOsShellTool({ approvals: gate, approvalRequired: false });
    const result = await tool.run(call, makeCtx(dir));
    expect(result.status).toBe("error");
    expect(result.summary).toContain("use the browser tool");
    expect(result.details.guardRule).toBe("browser.use_browser_tool");
    expect(prompts).toBe(0);
  });
});
