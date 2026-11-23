import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it, vi } from "vitest";

import { gitBinaryPatch } from "../tools/fusion/branch-diff.js";
import { createDirectoryIgnorePolicy } from "../tools/fusion/branch-ignore-policy.js";
import { preparePrivateGitSnapshot } from "../tools/fusion/private-git-workspace.js";
import { runGit } from "../tools/os/git/git-runner.js";
import { buildOsSandboxEnv, buildOsSandboxPolicy, wrapWithOsSandbox } from "./os-sandbox.js";

const realBubblewrap = process.platform === "linux" && process.env.ATOMIC_AGENT_REQUIRE_BWRAP === "1";
it.skipIf(!realBubblewrap)("Git and Fusion keep working inside Bubblewrap with late nested and separate metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "atomic-git-sandbox-"));
  try {
    const repo = join(root, "nested");
    const metadata = join(repo, "metadata.git");
    await mkdir(repo);
    vi.stubEnv("ATOMIC_AGENT_SANDBOX", "workspace");
    const git = (args: string[]) => runGit({
      workingDir: repo, args, signal: new AbortController().signal,
      env: { GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" },
    });
    expect((await git(["init", "--separate-git-dir", metadata])).exitCode).toBe(0);
    await writeFile(join(repo, "track.txt"), "old fixture\n");
    await writeFile(join(repo, ".gitignore"), "ignored/\n");
    expect((await git(["add", "track.txt", ".gitignore"])).exitCode).toBe(0);
    expect((await git(["commit", "-m", "synthetic fixture"])).exitCode).toBe(0);

    const policy = buildOsSandboxPolicy({ workspaceRoots: [root], network: false });
    expect(policy.readOnlyGitRoots).toEqual(expect.arrayContaining([join(repo, ".git"), metadata]));
    const launch = wrapWithOsSandbox(process.execPath, ["-e",
      "try{require('node:fs').appendFileSync(process.argv[1],'fixture');process.exit(2)}catch(e){process.exit(e.code==='EROFS'?0:3)}",
      join(metadata, "config"),
    ], policy, { cwd: root });
    if (!launch.ok) throw new Error(launch.reason);
    const child = spawnSync(launch.command, launch.args, { cwd: root, env: buildOsSandboxEnv(process.env), encoding: "utf8" });
    expect(child.status, child.stderr).toBe(0);

    const task = join(root, "task");
    await mkdir(task);
    await writeFile(join(task, "track.txt"), "new fixture\n");
    expect(await gitBinaryPatch(repo, task, ["track.txt"])).toContain("+new fixture");
    const classify = await createDirectoryIgnorePolicy({
      originalDir: repo, baseDir: repo, probeDir: join(root, "probe"), copy: copyFile,
    });
    expect(await classify?.(["ignored"])).toEqual(new Set(["ignored"]));

    const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
    const snapshot = await preparePrivateGitSnapshot({ source: repo, head, seed: join(root, "snapshot.git") });
    expect(snapshot.commit).toBe(head);
    expect(snapshot.trackedPaths).toContain("track.txt");
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
