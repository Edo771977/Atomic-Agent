import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import type { CompletionResult } from "../llm/llama-server-client.js";
import { resetConfigCache } from "../config/index.js";
import { RUN_MEMORY_TRACE_ENV, startRunMemoryTrace } from "./run-memory-trace.js";

/**
 * Issue #106: a short `run` with one chat turn, on the production path
 * with a scripted model, traced phase by phase: the turn, the gate check,
 * the save, the summary, and every step of the runtime's teardown.
 */
vi.mock("../runtime/bootstrap.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime/bootstrap.js")>();
  const complete = async (params: { sessionId: string }): Promise<CompletionResult> => ({
    content: params.sessionId.startsWith("reflection:") ? "" : JSON.stringify({ tool: "reply", args: { text: "ok" } }),
    reasoningContent: "", stop: true, truncated: false,
    timing: { promptMs: 0, predictedMs: 0, promptTokens: 5, predictedTokens: 3 },
    cacheHitTokens: 0, slotId: 0, modelId: null,
  });
  return {
    ...actual,
    createAgentRuntime: (options: Parameters<typeof actual.createAgentRuntime>[0]) =>
      actual.createAgentRuntime({ ...options, overrides: { skipLlamaHealthCheck: true, disableStreaming: true, llamaComplete: complete } }),
  };
});
vi.mock("./hard-exit-deadline.js", () => ({ armHardExitDeadline: () => () => {} }));

const { runAgentCommand } = await import("./run-agent.js");

type TraceRecord = Record<string, unknown> & { kind: string; t: number };

describe("run's memory trace around a chat turn (issue #106)", () => {
  let stateDir: string;
  let workingDir: string;
  const realStdin = process.stdin;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "aa-trace-run-state-"));
    workingDir = mkdtempSync(join(tmpdir(), "aa-trace-run-cwd-"));
    mkdirSync(join(workingDir, ".atomic-agent", "skills"), { recursive: true });
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    process.env.ATOMIC_AGENT_GRAMMARS_DIR = join(process.cwd(), "grammars");
    resetConfigCache();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
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

  it("records each phase entering and exiting in order, the shutdown steps inside the shutdown", async () => {
    const path = join(stateDir, "trace.ndjson");
    const trace = startRunMemoryTrace({ [RUN_MEMORY_TRACE_ENV]: path }, { intervalMs: 50 })!;
    Object.defineProperty(process, "stdin", { value: Readable.from(["hello\n"]), configurable: true });
    const code = await runAgentCommand(["--cwd", workingDir, "--no-approval"], { memoryTrace: trace });
    await trace.stop();
    expect(code).toBe(0);
    const records = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as TraceRecord);
    const phases = records.filter((r) => r.kind === "phase");
    const outer = phases.filter((r) => !(r.phase as string).startsWith("shutdown:")).map((r) => `${String(r.edge)}:${String(r.phase)}`);
    expect(outer).toEqual([
      "enter:boot", "exit:boot",
      "enter:stdin-read", "exit:stdin-read",
      "enter:turn", "exit:turn",
      "enter:settle-gates", "exit:settle-gates",
      "enter:stdin-read", "exit:stdin-read",
      "enter:settle-gates", "exit:settle-gates",
      "enter:session-save", "exit:session-save",
      "enter:result-print", "exit:result-print",
      "enter:hard-exit-arm", "exit:hard-exit-arm",
      "enter:stdin-close", "exit:stdin-close",
      "enter:shutdown", "exit:shutdown",
    ]);
    expect(phases.find((r) => r.phase === "turn" && r.edge === "exit")).toMatchObject({ ok: true, n: 1 });
    const steps = phases.filter((r) => (r.phase as string).startsWith("shutdown:"));
    expect(steps[0]).toMatchObject({ phase: "shutdown:compaction", edge: "enter" });
    expect(steps.at(-1)).toMatchObject({ phase: "shutdown:trace-export", edge: "exit" });
    const shutdownEnter = records.findIndex((r) => r.kind === "phase" && r.phase === "shutdown" && r.edge === "enter");
    const shutdownExit = records.findIndex((r) => r.kind === "phase" && r.phase === "shutdown" && r.edge === "exit");
    for (const step of steps) {
      const at = records.indexOf(step);
      expect(at).toBeGreaterThan(shutdownEnter);
      expect(at).toBeLessThan(shutdownExit);
    }
    expect(records.some((r) => r.kind === "main")).toBe(true);
  }, 60_000);
});
