/**
 * Issue #102 item 1: a worker's test runs are recorded from the tool
 * results (command, exit, file versions, each case and its outcome),
 * kept on the attempt even when the worker times out before its summary,
 * and shown to the reviewer as `## Execution evidence`.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FanoutScopeRegistry } from "../../approval/fanout-scope.js";
import type { RunTurnResult } from "../../agent/agent-loop.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import { FUSION_WORKER_ID_PREFIX } from "../../session/fusion-worker-session.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import type { ToolContext } from "../tool-registry.js";
import type { EscalationComplete } from "./escalation.js";
import { buildFusionDelegateTool, type FusionDelegateDeps } from "./fusion-delegate.js";
import type { FusionTeamContext } from "./team-routing.js";

const logger = new StructuredLogger({ level: "error", sinks: [] });
const mode = (): ResolvedRunMode => ({
  stored: "fusion", effective: "fusion", orchestratorProviderId: "cloud", orchestratorModel: "big",
  workerProviderId: "local", workerModel: "small", workers: 1, workersPinned: true, workerMaxSteps: 7,
  workerTimeoutMs: 60_000, primaryProviderId: "cloud", degraded: null, judge: { providerId: "cloud", model: "judge-model" },
});
const families: Record<string, "anthropic" | "openai" | "local"> = { "api-a": "anthropic", "cli-b": "openai", local: "local" };
const team: FusionTeamContext = {
  team: { directors: ["api-a:model-a"], workers: ["local:small"], reviewers: ["cli-b:model-r"] },
  fusion: { workerProvider: "local" },
  familyOf: (m) => families[m.providerId] ?? "other",
  reachable: () => true,
  pinsModel: (id) => id !== "local",
};
const review = (decision: "accept" | "needs-changes", why?: string): string =>
  JSON.stringify({ decision, issues: why === undefined ? [] : [{ item: "a3", severity: "blocker", file: "sales.cjs", why }] });

function deps(dir: string, complete: EscalationComplete, runTurn: FusionDelegateDeps["runTurn"], over: Partial<FusionDelegateDeps> = {}): FusionDelegateDeps {
  let minted = 0;
  return {
    runTurn,
    createEphemeralSession: (meta) => {
      minted += 1;
      return createEmptySessionState({ id: `${FUSION_WORKER_ID_PREFIX}${minted}`, workingDir: dir, metadata: { fusionWorker: { ...meta } } });
    },
    approvals: { setSessionPolicy: () => {}, clearSessionPolicy: () => {}, fanoutScopes: new FanoutScopeRegistry() },
    approvalRequired: false,
    emitEvent: () => {},
    workingDir: dir,
    slotManager: { poolSize: () => 4 },
    resolveRunMode: mode,
    resolveFusionTeam: () => team,
    workerSupportsSlotAffinity: () => false,
    warmWorkerBackend: async () => {},
    outputCharCap: 4000,
    logger,
    escalationComplete: complete,
    runChecks: async (specs) => ({ ok: true, results: specs.map(() => ({ ok: true, summary: "node --test: 6 passed" })) }),
    ...over,
  } as FusionDelegateDeps;
}
const ctx = (dir: string): ToolContext => ({ workingDir: dir, sessionId: "s-p", stepIndex: 0, signal: new AbortController().signal });

import { parseTestOutput } from "./execution-evidence.js";

const PROGRAM = "module.exports = (text) => text.split('\\n').filter((l) => l.trim() !== '');\n";
const TAP = [
  "TAP version 13",
  "# Subtest: sums revenue",
  "ok 1 - sums revenue",
  "  ---",
  "  duration_ms: 0.61",
  "  ...",
  "# Subtest: skips blank lines",
  "ok 2 - skips blank lines",
  "# Subtest: ignores __proto__",
  "ok 3 - ignores __proto__",
  "1..3",
  "# tests 3",
  "# pass 3",
  "# fail 0",
].join("\n");
const ev = (event: Record<string, unknown>) => ({ type: "llm_event", event: { batchIndex: 0, batchSize: 1, ...event } }) as never;
/** The worker writes sales.cjs, runs its suite through verify.run, then replies or hangs. */
function worker(dir: string, hang: boolean): FusionDelegateDeps["runTurn"] {
  let turns = 0;
  return async (session, _message, options) => {
    turns += 1;
    options.eventHook?.({ type: "turn_started", turnIndex: 0 } as never);
    if (turns === 1) {
      options.eventHook?.(ev({ type: "tool_call_parsed", call: { tool: "os.fs.write", args: { path: "sales.cjs", content: PROGRAM } } }));
      writeFileSync(join(dir, "sales.cjs"), PROGRAM);
      options.eventHook?.(ev({ type: "tool_call_executed", result: { tool: "os.fs.write", status: "ok", summary: "", details: {}, truncated: false } }));
      options.eventHook?.({ type: "step_finished", stepIndex: 0, summary: "", durationMs: 1 } as never);
      options.eventHook?.(ev({ type: "tool_call_parsed", call: { tool: "verify.run", args: { kind: "command", cmd: "node", args: ["--test", "sales.test.cjs"] } } }));
      options.eventHook?.(ev({ type: "tool_call_executed", result: { tool: "verify.run", status: "ok", summary: "verify.run command: passed (exit 0)", details: { exitCode: 0, stdoutTail: TAP }, truncated: false } }));
      options.eventHook?.({ type: "step_finished", stepIndex: 1, summary: "", durationMs: 1 } as never);
      if (hang) {
        await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
        return { session: createEmptySessionState({ id: session.id, workingDir: dir }), reason: "cancelled", stepCount: 2 } as RunTurnResult;
      }
    }
    return { session: createEmptySessionState({ id: session.id, workingDir: dir }), reason: "reply", stepCount: 2 } as RunTurnResult;
  };
}
const contract = { checks: [{ task: "program", type: "command", command: "node --test sales.test.cjs" }] };
const program = [{ id: "program", title: "Program", instructions: "write sales.cjs", files: ["sales.cjs"] }];

describe("execution evidence (issue #102)", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("parses node --test TAP and spec output into cases and totals", () => {
    expect(parseTestOutput(TAP)).toEqual({
      tests: [{ name: "sums revenue", ok: true }, { name: "skips blank lines", ok: true }, { name: "ignores __proto__", ok: true }],
      counts: { pass: 3, fail: 0, total: 3 },
    });
    expect(parseTestOutput("✔ sums revenue (0.6ms)\n✖ skips blank lines (1.2ms)\nℹ tests 2\nℹ pass 1\nℹ fail 1")).toEqual({
      tests: [{ name: "sums revenue", ok: true }, { name: "skips blank lines", ok: false }],
      counts: { pass: 1, fail: 1, total: 2 },
    });
    expect(parseTestOutput("all good")).toEqual({ tests: [] });
  });

  it("the reviewer sees each case, its outcome and the file version it ran against", async () => {
    const dir = mkdtempSync(join(tmpdir(), "execution-evidence-"));
    try {
      const prompts: string[] = [];
      const complete: EscalationComplete = async (call) => { prompts.push(call.prompt); return { content: review("accept") }; };
      await buildFusionDelegateTool(deps(dir, complete, worker(dir, false))).run({ tasks: program, contract }, ctx(dir));
      const prompt = prompts.find((p) => p.includes("strict acceptance judge"))!;
      expect(prompt).toContain("## Execution evidence");
      expect(prompt).toContain("verify.run: node --test sales.test.cjs — exit 0; 3 passed, 0 failed of 3");
      expect(prompt).toContain("- ok: skips blank lines");
      expect(prompt).toContain("- ok: ignores __proto__");
      expect(prompt).toMatch(/ran against: sales\.cjs sha256 [0-9a-f]{12} \(the version under review\)/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("a worker that times out right after its run keeps the run on its attempt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "execution-evidence-timeout-"));
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      const pending = buildFusionDelegateTool(deps(dir, async () => ({ content: review("accept") }), worker(dir, true))).run({ tasks: program }, ctx(dir));
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      const row = ((await pending).details.tasks as Array<{ id: string; status: string; attempt?: { executed?: Array<{ command: string; tests: unknown[] }> } }>)[0]!;
      expect(row.status).toBe("timeout");
      expect(row.attempt?.executed?.[0]).toMatchObject({ command: "node --test sales.test.cjs", exitCode: 0, tests: [{ name: "sums revenue", ok: true }, { name: "skips blank lines", ok: true }, { name: "ignores __proto__", ok: true }] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("re-review from the recorded run after a timeout (issue #102)", () => {
  afterEach(() => { vi.useRealTimers(); });

  /** A check that passes only on the program the worker ran its suite on. */
  const checksOn = (dir: string, seen: string[]): FusionDelegateDeps["runChecks"] => async (specs) => {
    const now = readFileSync(join(dir, "sales.cjs"), "utf8");
    seen.push(now);
    const ok = now === PROGRAM;
    return { ok, results: specs.map(() => (ok ? { ok: true, summary: "passed" } : { ok: false, summary: "verify.run command: FAILED (exit 1): 1 failed" })) };
  };

  it("the suite passed, then the worker timed out: the reviewer rules on the recorded run, no new worker, no rewrite", async () => {
    const dir = mkdtempSync(join(tmpdir(), "review-from-record-"));
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      const prompts: string[] = [];
      const complete: EscalationComplete = async (call) => { prompts.push(call.prompt); return { content: review("accept") }; };
      let turns = 0;
      const inner = worker(dir, true);
      const runTurn: FusionDelegateDeps["runTurn"] = async (...args) => { turns += 1; return inner(...args); };
      const seen: string[] = [];
      const pending = buildFusionDelegateTool(deps(dir, complete, runTurn, { runChecks: checksOn(dir, seen) })).run({ tasks: program, contract }, ctx(dir));
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      const result = await pending;
      const row = (result.details.tasks as Array<{ id: string; status: string; review?: { decision: string } }>)[0]!;
      expect(row.status).toBe("ok");
      expect(row.review?.decision).toBe("accept");
      expect(turns).toBe(1);
      expect(readFileSync(join(dir, "sales.cjs"), "utf8")).toBe(PROGRAM);
      const prompt = prompts.find((p) => p.includes("strict acceptance judge"))!;
      expect(prompt).toContain("## Execution evidence");
      expect(prompt).toContain("- ok: ignores __proto__");
      // The task's own check ran on the version under review.
      expect(seen).toContain(PROGRAM);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("files changed after the recorded run: the checks run on the new version and it is not accepted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "review-from-record-changed-"));
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      const inner = worker(dir, false);
      let turns = 0;
      const runTurn: FusionDelegateDeps["runTurn"] = async (session, message, options) => {
        turns += 1;
        if (turns > 1) return inner(session, message, options);
        // The run passes, then a later write breaks the file, then the clock ends it.
        const done = inner(session, message, options);
        await done;
        writeFileSync(join(dir, "sales.cjs"), "module.exports = () => { throw new Error('broken'); };\n");
        await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
        return { session: createEmptySessionState({ id: session.id, workingDir: dir }), reason: "cancelled", stepCount: 3 } as RunTurnResult;
      };
      const seen: string[] = [];
      const pending = buildFusionDelegateTool(deps(dir, async () => ({ content: review("accept") }), runTurn, { runChecks: checksOn(dir, seen) })).run({ tasks: program, contract }, ctx(dir));
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      const row = ((await pending).details.tasks as Array<{ id: string; status: string; review?: { decision: string } }>)[0]!;
      expect(seen.some((v) => v.includes("broken"))).toBe(true);
      expect(row.review?.decision).not.toBe("accept");
      expect(row.status).not.toBe("ok");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
