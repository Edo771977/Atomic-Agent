/**
 * Issue #102 review: a worker that times out is recovered as `ok` for a
 * review from its recorded run only when it wrote a declared file, its
 * last check run is one of the task's own contract checks, that run
 * passed after its last write, and the files still hash as it recorded.
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
import { getConfig } from "../../config/index.js";
import { runChecks as runVerifyChecks } from "../verify/index.js";
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

export const PROGRAM = "module.exports = (text) => text.split('\\n').filter((l) => l.trim() !== '');\n";
export const TAP = ["TAP version 13", "ok 1 - sums revenue", "ok 2 - skips blank lines", "1..2", "# tests 2", "# pass 2", "# fail 0"].join("\n");
/** The task's own check, as a verify.run spec. */
export const OWN = { kind: "command", cmd: "node", args: ["--test", "sales.test.cjs"] };

export type Step =
  | { write: string }
  | { verify: Record<string, unknown> }
  | { shell: string; output?: string };

const ev = (event: Record<string, unknown>) => ({ type: "llm_event", event: { batchIndex: 0, batchSize: 1, ...event } }) as never;

/** A worker that plays `steps` (one step each) on its first turn, then hangs until its clock or an abort ends it. */
export function scripted(dir: string, steps: readonly Step[], onHang?: () => void): FusionDelegateDeps["runTurn"] {
  let turns = 0;
  return async (session, _message, options) => {
    turns += 1;
    options.eventHook?.({ type: "turn_started", turnIndex: 0 } as never);
    if (turns === 1) {
      steps.forEach((step, stepIndex) => {
        if ("write" in step) {
          options.eventHook?.(ev({ type: "tool_call_parsed", call: { tool: "os.fs.write", args: { path: "sales.cjs", content: step.write } } }));
          writeFileSync(join(dir, "sales.cjs"), step.write);
          options.eventHook?.(ev({ type: "tool_call_executed", result: { tool: "os.fs.write", status: "ok", summary: "", details: {}, truncated: false } }));
        } else if ("verify" in step) {
          options.eventHook?.(ev({ type: "tool_call_parsed", call: { tool: "verify.run", args: step.verify } }));
          options.eventHook?.(ev({ type: "tool_call_executed", result: { tool: "verify.run", status: "ok", summary: "verify.run command: passed (exit 0)", details: { exitCode: 0, stdoutTail: TAP }, truncated: false } }));
        } else {
          options.eventHook?.(ev({ type: "tool_call_parsed", call: { tool: "os.shell.run", args: { cmd: step.shell } } }));
          options.eventHook?.(ev({ type: "tool_call_executed", result: { tool: "os.shell.run", status: "ok", summary: `$ ${step.shell}\nexit: 0\n${step.output ?? ""}`, details: { exitCode: 0 }, truncated: false } }));
        }
        options.eventHook?.({ type: "step_finished", stepIndex, summary: "", durationMs: 1 } as never);
      });
      onHang?.();
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) resolve();
        options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return { session: createEmptySessionState({ id: session.id, workingDir: dir }), reason: "cancelled", stepCount: steps.length } as RunTurnResult;
    }
    return { session: createEmptySessionState({ id: session.id, workingDir: dir }), reason: "reply", stepCount: 1 } as RunTurnResult;
  };
}

/** One delegate call of the program task with the worker `steps`; the row as it came back. */
export async function timedOut(steps: readonly Step[], opts: { files?: string[] | null; contract?: boolean; abort?: boolean; runChecks?: FusionDelegateDeps["runChecks"] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "recovery-guard-"));
  try {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const controller = new AbortController();
    const prompts: string[] = [];
    const complete: EscalationComplete = async (call) => { prompts.push(call.prompt); return { content: review("accept") }; };
    const runTurn = scripted(dir, steps, opts.abort === true ? () => controller.abort() : undefined);
    const files = opts.files === null ? {} : { files: opts.files ?? ["sales.cjs"] };
    const pending = buildFusionDelegateTool(deps(dir, complete, runTurn, opts.runChecks === undefined ? {} : { runChecks: opts.runChecks })).run({
      tasks: [{ id: "program", title: "Program", instructions: "write sales.cjs", ...files }],
      ...(opts.contract === false ? {} : { contract: { checks: [{ task: "program", ...OWN }] } }),
    }, { ...ctx(dir), signal: controller.signal });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    const row = ((await pending).details.tasks as Array<{ id: string; status: string; timedOutAfterRun?: true; notes?: string[] }>)[0]!;
    return { row, prompts, file: (() => { try { return readFileSync(join(dir, "sales.cjs"), "utf8"); } catch { return undefined; } })() };
  } finally {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("a timed-out worker is recovered for review only on its own passing checks (issue #102 review)", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("the reviewer's probe: no write, a passing `ls test`, a hang: it stays timeout", async () => {
    const { row } = await timedOut([{ shell: "ls test", output: "sales.test.cjs" }]);
    expect(row.status).toBe("timeout");
    expect(row.timedOutAfterRun).toBeUndefined();
  });

  it("the write, then its own check passing on that version, then the hang: recovered", async () => {
    const { row } = await timedOut([{ write: PROGRAM }, { verify: OWN }]);
    expect(row.status).toBe("ok");
    expect(row.timedOutAfterRun).toBe(true);
  });

  it("the recovered row carries one note for it, not the time-limit split advice nor the empty-reply warning", async () => {
    const { row } = await timedOut([{ write: PROGRAM }, { verify: OWN }]);
    const notes = row.notes ?? [];
    expect(notes).toContain("timed out after its own checks passed on the current files; reply missing");
    expect(notes.join("\n")).not.toMatch(/split it into smaller tasks/);
    expect(notes.join("\n")).not.toMatch(/reply is empty or a placeholder/);
  });

  const stays = (row: { status: string; timedOutAfterRun?: true }) => {
    expect(row.status).not.toBe("ok");
    expect(row.timedOutAfterRun).toBeUndefined();
  };

  it("its own check passed before the write: stays timeout", async () => {
    const { row } = await timedOut([{ verify: OWN }, { write: PROGRAM }]);
    expect(row.status).toBe("timeout");
    stays(row);
  });

  it("a test-runner shell command passed after the write, not one of its own checks: stays timeout", async () => {
    const { row } = await timedOut([{ write: PROGRAM }, { shell: "npm test", output: "# pass 2\n# fail 0" }]);
    expect(row.status).toBe("timeout");
    stays(row);
  });

  it("its own check passed but the attempt wrote nothing: stays timeout", async () => {
    const { row } = await timedOut([{ verify: OWN }]);
    expect(row.status).toBe("timeout");
    stays(row);
  });

  it("no own checks (no contract): stays timeout", async () => {
    const { row } = await timedOut([{ write: PROGRAM }, { verify: OWN }], { contract: false });
    expect(row.status).toBe("timeout");
    stays(row);
  });

  it("no declared files: stays timeout", async () => {
    const { row } = await timedOut([{ write: PROGRAM }, { verify: OWN }], { files: null });
    expect(row.status).toBe("timeout");
    stays(row);
  });

  it("an operator abort after the passing check: never recovered", async () => {
    const { row } = await timedOut([{ write: PROGRAM }, { verify: OWN }], { abort: true });
    stays(row);
  });
});

describe("recovery with the real gate checks (issue #102 review)", () => {
  it("the gate runs the task's own node --test suite on the current files and the reviewer accepts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recovery-real-gate-"));
    try {
      writeFileSync(join(dir, "sales.test.cjs"), [
        "const test = require('node:test');",
        "const assert = require('node:assert');",
        "const parse = require('./sales.cjs');",
        "test('skips blank lines', () => assert.deepStrictEqual(parse('a\\n\\nb'), ['a', 'b']));",
      ].join("\n"));
      const own = { kind: "command", cmd: process.execPath, args: ["--test", "sales.test.cjs"] };
      const runTurn = scripted(dir, [{ write: PROGRAM }, { verify: own }]);
      const gateRuns: boolean[] = [];
      const runChecks: FusionDelegateDeps["runChecks"] = async (specs, run) => {
        const out = await runVerifyChecks(specs, { workingDir: run.workingDir, signal: run.signal, config: getConfig() });
        gateRuns.push(out.ok);
        return out;
      };
      const prompts: string[] = [];
      const complete: EscalationComplete = async (call) => { prompts.push(call.prompt); return { content: review("accept") }; };
      // A short clock in real time: the real suite runs under real timers.
      const d = deps(dir, complete, runTurn, { runChecks, resolveRunMode: () => ({ ...mode(), workerTimeoutMs: 400 }) });
      const result = await buildFusionDelegateTool(d).run({
        tasks: [{ id: "program", title: "Program", instructions: "write sales.cjs", files: ["sales.cjs"] }],
        contract: { checks: [{ task: "program", ...own }] },
      }, ctx(dir));
      const row = (result.details.tasks as Array<{ status: string; timedOutAfterRun?: true; review?: { decision: string } }>)[0]!;
      expect(row.status).toBe("ok");
      expect(row.timedOutAfterRun).toBe(true);
      expect(gateRuns.length).toBeGreaterThan(0);
      expect(gateRuns.every((ok) => ok)).toBe(true);
      expect(row.review?.decision).toBe("accept");
      expect(prompts.some((p) => p.includes("## Execution evidence"))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);
});
