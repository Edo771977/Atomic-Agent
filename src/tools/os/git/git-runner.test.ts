import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import { sandboxGitArgs } from "../../../sandbox/sandbox-git.js";
import { runGit } from "./git-runner.js";
import { makeGitRepo } from "./test-helpers.js";

describe("runGit", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await makeGitRepo();
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("prepends --no-pager so git never blocks on a pager (cross-platform)", async () => {
    const result = await runGit({
      repo,
      workingDir: repo,
      args: ["rev-parse", "--is-inside-work-tree"],
      signal: new AbortController().signal,
    });
    expect(result.args[0]).toBe("--no-pager");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("true");
  });
});

it("review 2: host-side Git bypasses configured hooks and helpers in Safe Mode", async () => {
  const repo = await makeGitRepo();
  try {
    vi.stubEnv("ATOMIC_AGENT_SANDBOX", "workspace");
    expect(sandboxGitArgs()).toEqual(expect.arrayContaining([
      "core.fsmonitor=false", "core.hooksPath=/dev/null", "gpg.program=/dev/null", "core.sshCommand=/dev/null",
    ]));
  } finally {
    vi.unstubAllEnvs();
    await rm(repo, { recursive: true, force: true });
  }
});

it("round 3 point 2: Git refuses to launch against protected state", async () => {
  const repo = await makeGitRepo();
  try {
    vi.stubEnv("ATOMIC_AGENT_SANDBOX", "workspace");
    vi.stubEnv("ATOMIC_AGENT_STATE_DIR", repo);
    await expect(runGit({
      repo, workingDir: repo, args: ["rev-parse", "--is-inside-work-tree"],
      signal: new AbortController().signal,
    })).rejects.toThrow("protected agent state");
  } finally {
    vi.unstubAllEnvs();
    await rm(repo, { recursive: true, force: true });
  }
});
