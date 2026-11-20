import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runChecks, runVerify } from "./run-verify.js";
import { runCommandKind } from "./run-command-kind.js";
vi.mock("./run-service-kind.js", () => ({ runServiceKind: vi.fn(async () => { throw new Error("executor should have been refused"); }) }));
vi.mock("./run-page-kind.js", () => ({ runPageKind: vi.fn(async () => { throw new Error("executor should have been refused"); }), defaultBrowserLauncher: vi.fn() }));
vi.mock("./run-command-kind.js", () => ({ runCommandKind: vi.fn(async () => ({ commandLine: "fixture", exitCode: 0, signal: null, timedOut: false, aborted: false, stdout: "", stderr: "", stdoutTail: "", stderrTail: "", durationMs: 0 })) }));
const workingDir = resolve("verification-source-fixture");
const dir = resolve("verification-copy-fixture");
const ctx = () => ({ workingDir, signal: new AbortController().signal, workspace: async () => ({ dir, isolated: true, method: "copy" as const, cleanup: async () => {} }) });
beforeEach(() => vi.clearAllMocks());

describe("verification programmatic pre-execution policy", () => {
  it("refuses a hardline command in runChecks without reaching the executor", async () => {
    const result = await runChecks([{ kind: "command", cmd: "rm", args: ["-rf", "~"] }], ctx());
    expect(result.ok).toBe(false);
    expect(result.results[0]?.error).toMatch(/shell guard.*hardline/);
    expect(runCommandKind).not.toHaveBeenCalled();
  });

  it("refuses a hardline service or page start without launching anything", async () => {
    for (const kind of ["service", "page"]) {
      const result = await runVerify({ kind, start: { cmd: "rm", args: ["-rf", "~"] }, ready: { port: 3000 }, url: "http://127.0.0.1:3000" }, ctx());
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/shell guard.*hardline/);
    }
    expect(runCommandKind).not.toHaveBeenCalled();
  });

  it("cancellation before preparation starts no executor", async () => {
    const controller = new AbortController(); controller.abort();
    const workspace = vi.fn();
    const result = await runVerify({ kind: "command", cmd: "node", args: ["safe.js"] }, { ...ctx(), signal: controller.signal, workspace });
    expect(result.errorCode).toBe("cancelled"); expect(workspace).not.toHaveBeenCalled(); expect(runCommandKind).not.toHaveBeenCalled();
  });
});


describe("verification environment and lifecycle", () => {
  it("classifies command-defining git environment as dangerous", async () => {
    const { guardVerifyRun } = await import("./verify-run-guard.js");
    const { parseVerifyRunArgs } = await import("./verify-run-args.js");
    const guard = guardVerifyRun(parseVerifyRunArgs({ kind: "command", cmd: "git", args: ["status"], env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "fixture-program" } }), workingDir);
    expect(guard.dangerous[0]?.verdict.rule).toMatch(/^dangerous\./);
  });
  it("applies injected live operator policy to the actual rebased command", async () => {
    const result = await runVerify({ kind: "command", cmd: "git", args: ["push"] }, { ...ctx(), shellPolicy: { isGitRemoteSyncEnabled: () => false } });
    expect(result.ok).toBe(false); expect(result.error).toContain("policy.git_remote_sync_off"); expect(runCommandKind).not.toHaveBeenCalled();
  });
});

describe("verifyPlainCommand on the approval request (issue #95)", () => {
  const ask = async (spec: Record<string, unknown>) => {
    const { authorizeVerifyBatch } = await import("./verify-authorization.js");
    const seen: Record<string, unknown>[] = [];
    const approvals = { request: async (req: Record<string, unknown>) => { seen.push(req); return { approvalId: "x", approved: true }; } };
    await authorizeVerifyBatch([spec], { approvals: approvals as never, approvalRequired: true }, { sessionId: "s", workingDir, stepIndex: 0, signal: new AbortController().signal } as never);
    return seen[0]!;
  };
  it("marks one command with no env and no stdin, and nothing else", async () => {
    expect((await ask({ kind: "command", cmd: "node", args: ["--test", "sales.test.cjs"] })).verifyPlainCommand).toBe(true);
    expect((await ask({ kind: "command", cmd: "node", args: ["--test"], env: { NODE_OPTIONS: "--require ./x.cjs" } })).verifyPlainCommand).toBeUndefined();
    expect((await ask({ kind: "command", cmd: "node", args: ["-"], stdin: "console.log(1)" })).verifyPlainCommand).toBeUndefined();
  });
});

describe("a host's pinned exec on a verify.run check (issue #95)", () => {
  it("replaces the approved spec's program with the pinned file, and only for a plain check whose argv it equals", async () => {
    const { authorizeVerifyBatch } = await import("./verify-authorization.js");
    const run = async (spec: Record<string, unknown>, argv: string[]) => {
      const approvals = { request: async () => ({ approvalId: "x", approved: true, pinnedExec: { file: process.execPath, argv, cwd: workingDir } }) };
      return (await authorizeVerifyBatch([spec], { approvals: approvals as never, approvalRequired: true }, { sessionId: "s", workingDir, stepIndex: 0, signal: new AbortController().signal } as never))[0]!;
    };
    expect(await run({ kind: "command", cmd: "node", args: ["--test"] }, ["node", "--test"])).toMatchObject({ cmd: process.execPath, args: ["--test"] });
    expect(await run({ kind: "command", cmd: "node", args: ["--test"] }, ["node", "--other"])).toMatchObject({ cmd: "node", args: ["--test"] });
    expect(await run({ kind: "command", cmd: "node", args: ["--test"], env: { A: "1" } }, ["node", "--test"])).toMatchObject({ cmd: "node" });
  });
});
