import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { learnedSkillScope, withLearnedDecision, withLearnedTurn } from "./learn-scope.js";

let folder: string;
beforeEach(async () => { folder = await mkdtemp(join(tmpdir(), "learn-lock-")); });
afterEach(async () => { await rm(folder, { recursive: true, force: true }); });

it("bounds a turn's wait for an ongoing learned-skill decision", async () => {
  const scope = learnedSkillScope(folder, folder);
  let release!: () => void;
  let locked!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const acquired = new Promise<void>(resolve => { locked = resolve; });
  const decision = withLearnedDecision(scope.stateDir, async () => {
    locked();
    await gate;
  });
  await acquired;
  const run = vi.fn(async () => "ran");
  const timer = setTimeout(release, 1600);
  try {
    await expect(withLearnedTurn(folder, folder, run)).rejects.toThrow(/approval.*in progress/i);
    expect(run).not.toHaveBeenCalled();
  } finally {
    clearTimeout(timer);
    release();
    await decision;
  }
});

it("takes over an abandoned decision lock without waiting for its age limit", async () => {
  const scope = learnedSkillScope(folder, folder);
  await mkdir(scope.stateDir, { recursive: true });
  await writeFile(join(scope.stateDir, ".activate-lock"), JSON.stringify({
    host: hostname(), pid: 2147483647, at: Date.now(), token: "abandoned",
  }));
  await expect(withLearnedTurn(folder, folder, async () => "ran")).resolves.toBe("ran");
});
