import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetConfigCache } from "../config/index.js";
import {
  applyProjectDecision,
  applyProjectUpdate,
  gateVersion,
  withProject,
  type AssignmentRow,
  type ProjectState,
  type ProjectUpdate,
} from "../session/session-project.js";
import { createEmptySessionState } from "../session/session-state.js";
import { SessionStore } from "../session/session-store.js";

/**
 * Issue #100: the real `run` entry, spawned with stdin already closed.
 * When the run reaches a decision only a person can make, it must say
 * how to resume and exit with the documented code, in bounded time;
 * a plain chat with nothing waiting still exits 0.
 */
const NOW = 1_700_000_000_000;
const EXIT_WITHIN_MS = 45_000;

const up = (p: ProjectState | undefined, u: ProjectUpdate): ProjectState => {
  const r = applyProjectUpdate(p, u, NOW);
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
};
const approve = (p: ProjectState): ProjectState => {
  const r = applyProjectDecision(p, { gate: p.gate, version: gateVersion(p)!, verdict: "approve" }, { now: NOW });
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
};
const row = (taskId: string): AssignmentRow => ({
  taskId, title: taskId, milestoneId: "m1", worker: "local-llama:small", reviewer: null, reason: "preset", basis: "preset",
  samples: 0, estCostUsd: null, estMs: null,
});
/** A project whose only milestone was done and approved: nothing waits on anyone. */
function completedProject(): ProjectState {
  const brief: ProjectUpdate = { kind: "brief", brief: { what: "CSV summary", users: "Ops", how: "Node", successCriteria: ["Sums"] }, draftedAfterUntrusted: false };
  const plan: ProjectUpdate = { kind: "plan", milestones: [{ id: "m1", title: "Base", kind: "base" }], rows: [row("sales")], detail: "compact" };
  const running = approve(up(approve(up(undefined, brief)), plan));
  return approve(up(up(running, { kind: "milestone_run", id: "m1", runId: "r1" }), { kind: "milestone", id: "m1", state: "done", summary: "both accepted" } as ProjectUpdate));
}

/** A project whose milestone m1 was reported failed: its gate waits on a person. */
function failedMilestoneProject(): ProjectState {
  const brief: ProjectUpdate = { kind: "brief", brief: { what: "CSV summary", users: "Ops", how: "Node", successCriteria: ["Sums"] }, draftedAfterUntrusted: false };
  const plan: ProjectUpdate = { kind: "plan", milestones: [{ id: "m1", title: "Base", kind: "base" }], rows: [row("sales")], detail: "compact" };
  const running = approve(up(approve(up(undefined, brief)), plan));
  return up(up(running, { kind: "milestone_run", id: "m1", runId: "r1" }), { kind: "milestone", id: "m1", state: "failed", summary: "two reviews asked for changes" } as ProjectUpdate);
}

/** `ms`: until the pipes closed, which needs every holder of them gone (issue #102), not only `exit`. */
interface Ran { code: number | null; stdout: string; stderr: string; ms: number; exitMs: number }

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<Ran> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "cli", "index.ts"), "run", ...args], {
      env, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => { stdout += b.toString(); });
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
    // stdin closed from the start: EOF before any line.
    child.stdin.end();
    const killer = setTimeout(() => child.kill("SIGKILL"), EXIT_WITHIN_MS);
    child.on("error", reject);
    let exitMs = -1;
    child.on("exit", () => { exitMs = Date.now() - started; });
    // `close` fires once stdout and stderr are closed: a child the CLI left
    // behind holding them (an inherited handle) keeps them open.
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ code, stdout, stderr, ms: Date.now() - started, exitMs });
    });
  });
}

describe("run with stdin closed (issue #100)", () => {
  let stateDir: string;
  let workingDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-cli-eof-state-"));
    workingDir = mkdtempSync(join(tmpdir(), "atomic-cli-eof-cwd-"));
    mkdirSync(join(workingDir, ".atomic-agent", "skills"), { recursive: true });
    env = {
      ...process.env,
      ATOMIC_AGENT_STATE_DIR: stateDir,
      ATOMIC_AGENT_GRAMMARS_DIR: join(process.cwd(), "grammars"),
      ATOMIC_AGENT_ANALYTICS: "off",
    };
    delete env.VITEST;
    delete env.VITEST_WORKER_ID;
  });
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workingDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
  });

  /** Store a chat whose project waits at a failed milestone, as the director left it. */
  function seedFailedMilestone(): string {
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    const store = new SessionStore();
    // As a chat turn leaves it: `pending`, the status the run's summary printed.
    const session = withProject({ ...createEmptySessionState({ id: "s-eof-1", workingDir }), turnCount: 1 }, failedMilestoneProject());
    store.save(session);
    store.close();
    return session.id;
  }

  it("at a failed milestone under --auto-approve-project: prints how to resume and exits 3, in bounded time", async () => {
    const id = seedFailedMilestone();
    const ran = await runCli(["--cwd", workingDir, "--session", id, "--auto-approve-project"], env);
    expect(ran.ms).toBeLessThan(EXIT_WITHIN_MS);
    expect(ran.exitMs).toBeGreaterThanOrEqual(0);
    expect(ran.code).toBe(3);
    expect(ran.stderr).toContain(`session: ${id}`);
    expect(ran.stderr).toContain(`atomic-agent run --session ${id} --approve`);
    expect(ran.stderr).toContain("The milestone failed: this needs a person");
    // The session is still there to resume.
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    const store = new SessionStore();
    expect(store.load(id)?.project?.gate).toMatchObject({ kind: "milestone", id: "m1" });
    store.close();
  }, 60_000);

  it("a chat whose plan completed exits 0 and its pipes close (issue #106)", async () => {
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    const project = completedProject();
    expect(project.gate).toEqual({ kind: "none" });
    const store = new SessionStore();
    store.save(withProject({ ...createEmptySessionState({ id: "s-eof-done", workingDir }), turnCount: 1 }, project));
    store.close();
    const ran = await runCli(["--cwd", workingDir, "--session", "s-eof-done", "--auto-approve-project"], env);
    expect(ran.ms).toBeLessThan(EXIT_WITHIN_MS);
    expect(ran.exitMs).toBeGreaterThanOrEqual(0);
    expect(ran.code).toBe(0);
    expect(ran.stderr).not.toContain("watchdog");
  }, 60_000);

  it("a plain chat with nothing waiting still exits 0", async () => {
    const ran = await runCli(["--cwd", workingDir], env);
    expect(ran.ms).toBeLessThan(EXIT_WITHIN_MS);
    expect(ran.exitMs).toBeGreaterThanOrEqual(0);
    expect(ran.code).toBe(0);
  }, 60_000);
});
