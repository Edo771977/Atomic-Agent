import { afterEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { installPolicy } from "../../../policy/policy-active.js";
import { recordingGate } from "../../browser/browser-gate-test-helpers.js";
import { runGitRemote } from "./git-remote-policy.js";
import * as runner from "./git-runner.js";

afterEach(() => { installPolicy(null); vi.restoreAllMocks(); });
describe("independent Git URL decisions", () => {
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
