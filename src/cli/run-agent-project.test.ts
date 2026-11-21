import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import type { CompletionResult } from "../llm/llama-server-client.js";
import { resetConfigCache } from "../config/index.js";
import type { ProjectGateView } from "../session/project-gate-view.js";
import type { ProjectDecision } from "../session/session-project.js";
import { fixtureProjectGateView } from "../session/project-gate-view-fixtures.js";

/**
 * Issue #39: `run` at a fusion project gate. The project itself is the
 * runtime side's (stubbed here as `projectState` / `projectDecision`);
 * the turns run on the production path with a scripted model.
 */
const project = vi.hoisted(() => ({
  view: undefined as ProjectGateView | undefined,
  /** Becomes `view` when the next turn ends (the director opened a gate). */
  openAfterTurn: [] as Array<ProjectGateView | undefined>,
  /** What the runtime answers the next decision with. */
  after: undefined as ProjectGateView | undefined,
  decisions: [] as ProjectDecision[],
  messages: [] as string[],
  /** The project each turn ran with (`session.project` passed to runTurn). */
  turnProjects: [] as unknown[],
  /** What a refused decision answers (default: over today's limit). */
  refusal: undefined as undefined | { code: string; message: string; blocks?: unknown[] },
  /** Issue #100: a teardown that never ends (a flush that hangs); the real one runs after the test. */
  hangShutdown: false,
  realShutdowns: [] as Array<() => Promise<void>>,
}));

/** What the stubbed runtime stored with an approval. */
const DECIDED = { milestones: [], gate: { kind: "none" as const }, cancelledAt: 42 };

vi.mock("../runtime/bootstrap.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime/bootstrap.js")>();
  const completion = (content: string): CompletionResult => ({
    content, reasoningContent: "", stop: true, truncated: false,
    timing: { promptMs: 0, predictedMs: 0, promptTokens: 5, predictedTokens: 3 },
    cacheHitTokens: 0, slotId: 0, modelId: null,
  });
  const complete = async (params: { sessionId: string }): Promise<CompletionResult> =>
    completion(params.sessionId.startsWith("reflection:") ? "" : JSON.stringify({ tool: "reply", args: { text: "ok" } }));
  return {
    ...actual,
    createAgentRuntime: async (options: Parameters<typeof actual.createAgentRuntime>[0]) => {
      const runtime = await actual.createAgentRuntime({
        ...options,
        overrides: { skipLlamaHealthCheck: true, disableStreaming: true, llamaComplete: complete },
      });
      const runTurn = runtime.runTurn;
      const realShutdown = runtime.shutdown.bind(runtime);
      project.realShutdowns.push(realShutdown);
      return Object.assign(runtime, {
        shutdown: () => (project.hangShutdown ? new Promise<void>(() => {}) : realShutdown()),
        runTurn: async (...args: Parameters<typeof runTurn>) => {
          project.messages.push(args[1]);
          project.turnProjects.push(args[0].project);
          const result = await runTurn(...args);
          if (project.openAfterTurn.length > 0) project.view = project.openAfterTurn.shift();
          return result;
        },
        projectState: () => project.view ?? null,
        projectDecision: (_id: string, decision: ProjectDecision) => {
          project.decisions.push(decision);
          project.view = project.after;
          return project.after === undefined
            ? { ok: false as const, error: project.refusal ?? { code: "over-cap" as const, message: "over today's limit", violations: [] } }
            : { ok: true as const, project: DECIDED, view: project.after };
        },
      });
    },
  };
});

/** Issue #104: the deadline run arms once its summary is out; recorded, never fired here. */
const deadline = vi.hoisted(() => ({ armed: [] as Array<() => number> }));
vi.mock("./hard-exit-deadline.js", () => ({
  armHardExitDeadline: (code: () => number) => {
    deadline.armed.push(code);
    return () => {};
  },
}));

const { runAgentCommand } = await import("./run-agent.js");

const planGate = fixtureProjectGateView({ kind: "plan" });
const running = fixtureProjectGateView({ kind: "none" }, { expectation: { kind: "run_milestone", id: "m1" } });

describe("run at a fusion project gate", () => {
  let stateDir: string;
  let workingDir: string;
  let stderr = "";
  const realStdin = process.stdin;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-cli-project-state-"));
    workingDir = mkdtempSync(join(tmpdir(), "atomic-cli-project-cwd-"));
    mkdirSync(join(workingDir, ".atomic-agent", "skills"), { recursive: true });
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    process.env.ATOMIC_AGENT_GRAMMARS_DIR = join(process.cwd(), "grammars");
    resetConfigCache();
    Object.assign(project, { view: undefined, openAfterTurn: [], after: undefined, decisions: [], messages: [], turnProjects: [], refusal: undefined, hangShutdown: false, realShutdowns: [] });
    stderr = "";
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderr += typeof chunk === "string" ? chunk : String(chunk);
      return true;
    });
  });

  afterEach(() => {
    Object.defineProperty(process, "stdin", { value: realStdin, configurable: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workingDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    delete process.env.ATOMIC_AGENT_GRAMMARS_DIR;
    resetConfigCache();
    vi.restoreAllMocks();
  });

  const feed = (lines: string[]): void => {
    Object.defineProperty(process, "stdin", { value: Readable.from(lines), configurable: true });
  };
  const sessionIdIn = (text: string): string => /session: (\S+)/.exec(text)?.[1] ?? "";

  it("stops at the gate with its summary and the session id, exiting 3, and never approves", async () => {
    project.openAfterTurn = [planGate];
    feed(["build the game\n", "and more\n"]);
    const code = await runAgentCommand(["--cwd", workingDir, "--no-approval"]);
    expect(code).toBe(3);
    expect(project.messages).toEqual(["build the game"]);
    expect(project.decisions).toEqual([]);
    expect(stderr).toContain("The project plan waits for your approval");
    const id = sessionIdIn(stderr);
    expect(id).not.toBe("");
    expect(stderr).toContain(`atomic-agent run --session ${id} --approve 3`);
  }, 60_000);

  it("--approve without a version shows the gate and asks to repeat it with the version, exiting 3", async () => {
    project.openAfterTurn = [planGate];
    feed(["build the game\n"]);
    expect(await runAgentCommand(["--cwd", workingDir, "--no-approval"])).toBe(3);
    const id = sessionIdIn(stderr);
    stderr = "";
    project.after = running;
    project.messages = [];
    feed([]);
    expect(await runAgentCommand(["--cwd", workingDir, "--no-approval", "--session", id, "--approve"])).toBe(3);
    expect(project.decisions).toEqual([]);
    expect(project.messages).toEqual([]);
    expect(stderr).toContain("The project plan waits for your approval (version 3).");
    expect(stderr).toContain(`atomic-agent run --session ${id} --approve 3`);
  }, 60_000);

  it("--approve with a stale version is refused with the current one, exiting 1", async () => {
    project.openAfterTurn = [planGate];
    feed(["build the game\n"]);
    expect(await runAgentCommand(["--cwd", workingDir, "--no-approval"])).toBe(3);
    const id = sessionIdIn(stderr);
    stderr = "";
    project.after = running;
    feed([]);
    expect(await runAgentCommand(["--cwd", workingDir, "--no-approval", "--session", id, "--approve", "2"])).toBe(1);
    expect(project.decisions).toEqual([]);
    expect(stderr).toContain("not approved: the plan changed since version 2; current is 3");
  }, 60_000);

  it("--session X --approve approves the open gate and continues the stored chat", async () => {
    project.openAfterTurn = [planGate];
    feed(["build the game\n"]);
    expect(await runAgentCommand(["--cwd", workingDir, "--no-approval"])).toBe(3);
    const id = sessionIdIn(stderr);
    stderr = "";
    project.after = running;
    project.messages = [];
    project.turnProjects = [];
    feed([]);
    const code = await runAgentCommand(["--cwd", workingDir, "--no-approval", "--session", id, "--approve", "3"]);
    expect(code).toBe(0);
    expect(project.decisions).toEqual([{ gate: { kind: "plan" }, version: 3, verdict: "approve" }]);
    expect(stderr).toContain("project: approved the plan (version 3)");
    expect(project.messages).toEqual(['I approved. Continue with milestone "Base".']);
    // The continuing turn runs on the decided project, so its save keeps
    // the approval instead of writing the chat's older copy back.
    expect(project.turnProjects).toEqual([DECIDED]);
    expect(stderr).toContain('"turnCount": 2');
  }, 60_000);

  it("--approve with nothing waiting exits 1", async () => {
    feed(["hi\n"]);
    await runAgentCommand(["--cwd", workingDir, "--no-approval"]);
    const id = /"sessionId": "([^"]+)"/.exec(stderr)?.[1] ?? "";
    stderr = "";
    feed([]);
    expect(await runAgentCommand(["--cwd", workingDir, "--no-approval", "--session", id, "--approve", "1"])).toBe(1);
    expect(stderr).toContain(`nothing waits for approval on session ${id}`);
  }, 60_000);

  it("--auto-approve-project approves every gate as it opens and says so", async () => {
    const milestoneGate = fixtureProjectGateView({ kind: "milestone", id: "m1" });
    // The plan gate opens after the first turn; the continuing turn ends at the milestone gate.
    project.openAfterTurn = [planGate, milestoneGate];
    project.after = running;
    feed(["build the game\n"]);
    const code = await runAgentCommand(["--cwd", workingDir, "--no-approval", "--auto-approve-project"]);
    expect(code).toBe(0);
    expect(project.decisions.map((d) => d.gate.kind)).toEqual(["plan", "milestone"]);
    expect(stderr).toContain("project: approved the plan (version 3)");
    expect(stderr).toContain('project: approved milestone "Base" (version 3)');
  }, 60_000);

  it("--auto-approve-project stops at a failed milestone with exit 3: a person decides what next", async () => {
    const base = fixtureProjectGateView({ kind: "milestone", id: "m1" });
    const failed = { ...base, milestones: base.milestones.map((m) => (m.id === "m1" ? { ...m, state: "failed" as const, summary: "Tests fail" } : m)) };
    // Every turn of the director ends with the milestone failed again.
    project.openAfterTurn = [planGate, failed, failed, failed, failed];
    project.after = running;
    feed(["build the game\n"]);
    const code = await runAgentCommand(["--cwd", workingDir, "--no-approval", "--auto-approve-project"]);
    expect(code).toBe(3);
    // The hard deadline was armed with the run's own exit code (issue #104).
    expect(deadline.armed.at(-1)?.()).toBe(3);
    expect(project.decisions.map((d) => d.gate.kind)).toEqual(["plan"]);
    expect(project.messages).toHaveLength(2);
    expect(stderr).toMatch(/failed and waits for your review/);
    expect(stderr).toContain("needs a person");
  }, 60_000);

  it("a milestone auto-approve may not take (review-open) stops with exit 3 and how to resume (issue #100)", async () => {
    const milestoneGate = fixtureProjectGateView({ kind: "milestone", id: "m1" });
    project.openAfterTurn = [milestoneGate];
    project.refusal = { code: "review-open", message: "Task sales still has an open review block (needs-changes).", blocks: [] };
    feed(["build the game\n"]);
    const code = await runAgentCommand(["--cwd", workingDir, "--no-approval", "--auto-approve-project"]);
    expect(code).toBe(3);
    const id = sessionIdIn(stderr);
    expect(id).not.toBe("");
    expect(stderr).toContain("open review block");
    expect(stderr).toContain("needs a person");
    expect(stderr).toContain(`atomic-agent run --session ${id}`);
  }, 60_000);

  it("a teardown that never ends does not keep the run open: it returns its exit code in bounded time (issue #100)", async () => {
    const base = fixtureProjectGateView({ kind: "milestone", id: "m1" });
    const failed = { ...base, milestones: base.milestones.map((m) => (m.id === "m1" ? { ...m, state: "failed" as const, summary: "Tests fail" } : m)) };
    project.openAfterTurn = [failed];
    project.hangShutdown = true;
    feed(["build the game\n"]);
    const started = Date.now();
    const code = await runAgentCommand(["--cwd", workingDir, "--no-approval", "--auto-approve-project"]);
    expect(code).toBe(3);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(stderr).toContain("did not finish shutting down");
    project.hangShutdown = false;
    await Promise.all(project.realShutdowns.map((stop) => stop()));
  }, 30_000);

  it("an auto-approved gate that comes back unchanged stops with exit 3 instead of approving forever (issue #106)", async () => {
    // Every approval "succeeds", yet the same plan gate at the same version is open again after each turn.
    project.openAfterTurn = Array.from({ length: 40 }, () => planGate);
    project.after = planGate;
    feed(["build the game\n"]);
    const code = await runAgentCommand(["--cwd", workingDir, "--no-approval", "--auto-approve-project"]);
    expect(code).toBe(3);
    expect(project.decisions.length).toBeLessThanOrEqual(2);
    expect(stderr).toContain("made no progress");
    expect(stderr).toContain(`atomic-agent run --session ${sessionIdIn(stderr)}`);
  }, 60_000);

  it("an approval the runtime refuses (a hard cap) exits 1 with the reason", async () => {
    project.openAfterTurn = [planGate];
    feed(["build the game\n"]);
    const code = await runAgentCommand(["--cwd", workingDir, "--no-approval", "--auto-approve-project"]);
    expect(code).toBe(1);
    expect(stderr).toContain("Not approved: over today's limit");
  }, 60_000);
});
