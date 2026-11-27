import { afterEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { installPolicy } from "../../../policy/policy-active.js";
import { recordingGate } from "../../browser/browser-gate-test-helpers.js";
import { runGitRemote } from "./git-remote-policy.js";
import * as runner from "./git-runner.js";

afterEach(() => { installPolicy(null); vi.restoreAllMocks(); });
describe("independent Git URL decisions", () => {
  it.each(["origin", "git@fixture.test:repo.git", "./fixture.git"])("preserves ordinary Git outcomes for %s when it is not a configured remote name", async target => {
    installPolicy({ sources: [], mcpAllowlists: [], rules: [] });
    const calls: string[][] = [];
    vi.spyOn(runner, "runGit").mockImplementation(async input => {
      calls.push(input.args);
      return { exitCode: input.args[0] === "remote" ? 2 : input.args[0] === "ls-remote" ? 0 : 128,
        stdout: input.args[0] === "ls-remote" ? target : "", stderr: "fixture Git outcome", timedOut: false, truncated: false, args: input.args } as never;
    });
    const { options } = recordingGate(true);
    const result = await runGitRemote({ ...options, isRemoteSyncEnabled: () => true, env: {} }, { args: ["fetch", target], repo: tmpdir(), workingDir: tmpdir(), sessionId: "fixture", signal: new AbortController().signal });
    expect(result.exitCode).toBe(128);
    expect(result.stderr).toBe("fixture Git outcome");
    expect(calls.at(-1)).toContain("fetch");
  });
  it("checks URL data after resolving a Git URL rewrite instead of a configured remote", async () => {
    installPolicy({ sources: [], mcpAllowlists: [], rules: [] });
    const url = `https://fixture.test/repo.git?fixture=${"x".repeat(250)}`;
    let transported = false;
    vi.spyOn(runner, "runGit").mockImplementation(async input => {
      if (input.args[0] === "fetch") transported = true;
      return { exitCode: input.args[0] === "remote" ? 2 : 0, stdout: input.args[0] === "ls-remote" ? url : "", stderr: "", timedOut: false, truncated: false, args: input.args } as never;
    });
    const { options, prompts } = recordingGate(false);
    await runGitRemote({ ...options, isRemoteSyncEnabled: () => true, env: {} }, { args: ["fetch", "fixture:repo"], repo: tmpdir(), workingDir: tmpdir(), sessionId: "fixture", signal: new AbortController().signal }).catch(() => undefined);
    expect(prompts[0]).toMatchObject({ category: "http_write" });
    expect(transported).toBe(false);
  });
  it.each(["allow", "ask"] as const)("retains URL-data approval with policy %s", async effect => {
    installPolicy({ sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "webfetch", resource: "*", effect }] });
    const url = `https://fixture.test/repo.git?fixture=${"x".repeat(250)}`;
    const calls: string[][] = [];
    vi.spyOn(runner, "runGit").mockImplementation(async input => { calls.push(input.args); return { exitCode: 0, stdout: input.args.includes("get-url") ? url : "", stderr: "", timedOut: false, truncated: false, args: input.args } as never; });
    const { options, prompts } = recordingGate(true);
    await runGitRemote({ ...options, isRemoteSyncEnabled: () => true, env: {} }, { args: ["fetch", "origin"], repo: tmpdir(), workingDir: tmpdir(), sessionId: "fixture", signal: new AbortController().signal });
    expect(prompts.filter(prompt => prompt.category === "http_write")).toHaveLength(1);
    expect(prompts.filter(prompt => prompt.category === "http")).toHaveLength(effect === "ask" ? 1 : 0);
    expect(calls.at(-1)).toContain("fetch");
  });
});
