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
      return Object.assign(runtime, {
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
            ? { ok: false as const, error: { code: "over-cap" as const, message: "over today's limit", violations: [] } }
            : { ok: true as const, project: DECIDED, view: project.after };
        },
      });
    },
  };
});

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
    Object.assign(project, { view: undefined, openAfterTurn: [], after: undefined, decisions: [], messages: [], turnProjects: [] });
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

  it("an approval the runtime refuses (a hard cap) exits 1 with the reason", async () => {
    project.openAfterTurn = [planGate];
    feed(["build the game\n"]);
    const code = await runAgentCommand(["--cwd", workingDir, "--no-approval", "--auto-approve-project"]);
    expect(code).toBe(1);
    expect(stderr).toContain("Not approved: over today's limit");
  }, 60_000);
});
