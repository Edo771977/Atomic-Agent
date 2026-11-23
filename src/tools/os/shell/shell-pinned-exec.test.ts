import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApprovalGate, type ApprovalDecision, type ApprovalRequest } from "../../../approval/approval-gate.js";
import type { ToolContext } from "../../tool-registry.js";
import { buildOsShellTool } from "./shell.js";

/**
 * Issue #95 (second review): a `pinnedExec` on the gate's decision is
 * what runs (file, argv, cwd), whatever the tool would have spawned; it
 * only ever comes from the host's decision, never from the call.
 */
describe("os.shell.run with a pinned exec", () => {
  let dir: string;
  let decide: (request: ApprovalRequest) => Omit<ApprovalDecision, "approvalId">;
  let gate: ApprovalGate;
  beforeEach(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), "aa-pinned-")));
    writeFileSync(join(dir, "mark.cjs"), "require('node:fs').writeFileSync(require('node:path').join(process.cwd(), 'ran.txt'), process.argv.slice(2).join(' '));\n");
    gate = new ApprovalGate({
      level: 1,
      emit: (request) => queueMicrotask(() => gate.resolve({ approvalId: request.approvalId, ...decide(request) })),
    });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = (): ToolContext => ({ workingDir: dir, sessionId: "s-1", stepIndex: 0, signal: new AbortController().signal });
  const shell = (args: Record<string, unknown>) => buildOsShellTool({ approvals: gate, approvalRequired: true }).run(args, ctx());

  it("spawns the pinned file with the pinned argv, directly, not what the name would resolve to", async () => {
    decide = (request) => ({ approved: true, pinnedExec: { file: process.execPath, argv: request.commandArgv!, cwd: dir, path: dirname(process.execPath) } });
    // No such program on PATH: only the pin can run it.
    await shell({ cmd: "aa-no-such-program", args: ["mark.cjs", "a"] });
    expect(existsSync(join(dir, "ran.txt"))).toBe(true);
  });

  it("an exact host pin covers the URL decision in strict mode", async () => {
    const requests: string[] = [];
    decide = (request) => {
      requests.push(request.category);
      return request.commandArgv
        ? { approved: true, pinnedExec: { file: process.execPath, argv: request.commandArgv, cwd: dir, path: dirname(process.execPath) } }
        : { approved: false };
    };
    const run = buildOsShellTool({ approvals: gate, approvalRequired: true, urlDataGuard: "strict" });
    await run.run({ cmd: "curl", args: ["mark.cjs", "https://example.com/"] }, ctx());
    expect(requests).toEqual(["shell"]);
    expect(existsSync(join(dir, "ran.txt"))).toBe(true);
  });

  it("refuses a pin for another folder instead of running it there or unpinned", async () => {
    const other = realpathSync.native(mkdtempSync(join(tmpdir(), "aa-pinned-other-")));
    decide = (request) => ({ approved: true, pinnedExec: { file: process.execPath, argv: request.commandArgv!, cwd: other, path: dirname(process.execPath) } });
    await expect(shell({ cmd: "node", args: ["mark.cjs", "d"] })).rejects.toThrow(/not run/);
    expect(existsSync(join(dir, "ran.txt"))).toBe(false);
    expect(existsSync(join(other, "ran.txt"))).toBe(false);
    rmSync(other, { recursive: true, force: true });
  });

  it("ignores a pin whose argv is not the call's, and one sent as a tool argument", async () => {
    decide = () => ({ approved: true, pinnedExec: { file: join(tmpdir(), "sh"), argv: ["sh", "-c", `touch ${join(dir, "pwned.txt")}`], cwd: dir, path: dirname(process.execPath) } });
    await expect(shell({ cmd: "node", args: ["mark.cjs", "b"] })).rejects.toThrow(/not run/);
    expect(existsSync(join(dir, "pwned.txt"))).toBe(false);
    decide = () => ({ approved: true });
    await shell({ cmd: "node", args: ["mark.cjs", "c"], pinnedExec: { file: join(tmpdir(), "sh"), argv: ["sh", "-c", `touch ${join(dir, "pwned.txt")}`], cwd: dir, path: dirname(process.execPath) } });
    expect(existsSync(join(dir, "pwned.txt"))).toBe(false);
  });
});
