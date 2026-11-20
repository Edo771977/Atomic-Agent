import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApprovalGate, type ApprovalRequest } from "../../approval/approval-gate.js";
import type { RunTurnResult } from "../../agent/agent-loop.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import {
  applyProjectDecision,
  applyProjectUpdate,
  gateVersion,
  type AssignmentRow,
  type ProjectState,
  type ProjectUpdate,
} from "../../session/session-project.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { FUSION_WORKER_ID_PREFIX } from "../../session/fusion-worker-session.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import { buildFusionDelegateTool, type FusionDelegateDeps } from "./fusion-delegate.js";
import type { FusionTeamContext } from "./team-routing.js";

/**
 * Issue #104: what reaches the reviewer on an evidence review. In the
 * live run Codex said the evidence omitted the full TAP output and the
 * mapping of the 9 tests to the requirements, although the suite ran:
 * `node --test sales.test.cjs`, 9 passed, exit 0. The real judge prompt
 * is captured here and checked for each part.
 */
const logger = new StructuredLogger({ level: "error", sinks: [] });
const NOW = 1_700_000_000_000;
const ACCEPT = JSON.stringify({ decision: "accept", issues: [] });
const families: Record<string, "anthropic" | "openai" | "local"> = { "api-a": "anthropic", "cli-b": "openai", local: "local" };

const team = (over: Partial<FusionTeamContext> = {}, config: Partial<FusionTeamContext["team"]> = {}): FusionTeamContext => ({
  team: { directors: ["api-a:model-a"], workers: ["local:small"], reviewers: ["cli-b:model-r", "api-a:model-o"], ...config },
  fusion: { workerProvider: "local" },
  familyOf: (m) => families[m.providerId] ?? "other",
  reachable: () => true,
  pinsModel: (id) => id !== "local",
  ...over,
});

const mode = (): ResolvedRunMode => ({ autoReplan: 2,
  stored: "fusion", effective: "fusion", orchestratorProviderId: "api-a", orchestratorModel: "model-a",
  workerProviderId: "local", workerModel: "small", workers: 1, workersPinned: true,
  workerMaxSteps: 7, workerTimeoutMs: 60_000, primaryProviderId: "api-a", degraded: null,
});

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
/**
 * The live run's approvals: stdin closed, so nobody answers; only the
 * check command the run allowed (`--allow-command`) is approved. Every
 * other prompt is declined, and recorded.
 */
export function cliGate(asked: ApprovalRequest[]): ApprovalGate {
  const gate: ApprovalGate = new ApprovalGate({
    level: 1,
    emit: (req) => {
      const allowed = req.category === "shell";
      if (!allowed) asked.push(req);
      queueMicrotask(() => gate.resolve({ approvalId: req.approvalId, approved: allowed }));
    },
  });
  return gate;
}

export const NAMES = [
  "sums revenue per region",
  "skips blank lines",
  "skips whitespace-only lines",
  "ignores __proto__ keys",
  "rejects a missing header",
  "parses quoted fields",
  "handles a trailing newline",
  "rounds totals to cents",
  "prints JSON output",
];
/** `node --test` TAP for the worker's 9-test suite, as Node prints it. */
export const TAP = [
  "TAP version 13",
  ...NAMES.flatMap((name, i) => [`# Subtest: ${name}`, `ok ${i + 1} - ${name}`, "  ---", `  duration_ms: ${(0.4 + i / 10).toFixed(3)}`, "  type: 'test'", "  ..."]),
  "1..9", "# tests 9", "# suites 0", "# pass 9", "# fail 0", "# cancelled 0", "# skipped 0", "# todo 0", "# duration_ms 61.204",
].join("\n");
export const CRITERIA = ["sums revenue per region", "skips blank lines", "ignores __proto__ keys safely", "reports a malformed row on stderr"];
export const PROGRAM = "module.exports = (text) => text.split('\\n').filter((l) => l.trim() !== '');\n";
export const SUITE = "require('node:test')('sums revenue per region', () => {});\n";
/** The task's own check, as the contract states it; the worker spells the same command as one string. */
export const CONTRACT_CHECK = { kind: "command", cmd: "node", args: ["--test", "sales.test.cjs"] };
export const WORKER_SPEC = { kind: "command", cmd: "node --test sales.test.cjs" };

const planRow = (taskId: string): AssignmentRow => ({
  taskId, title: taskId, milestoneId: "m1", worker: "local:small", reviewer: "cli-b:model-r", reason: "preset", basis: "preset", samples: 0, estCostUsd: null, estMs: null,
});
export const projectOf = (taskIds: readonly string[]): ProjectState => {
  const brief: ProjectUpdate = { kind: "brief", brief: { what: "CSV sales report", users: "ops", how: "node", successCriteria: CRITERIA }, draftedAfterUntrusted: false };
  const plan: ProjectUpdate = { kind: "plan", milestones: [{ id: "m1", title: "CLI", kind: "base" }], rows: taskIds.map(planRow), detail: "compact" };
  return approve(up(approve(up(undefined, brief)), plan));
};
const ev = (event: Record<string, unknown>) => ({ type: "llm_event", event: { batchIndex: 0, batchSize: 1, ...event } }) as never;

/** The gate's own run of a check: the TAP above, exit 0. */
export const gateChecks: FusionDelegateDeps["runChecks"] = async (specs) => ({
  ok: true,
  results: specs.map(() => ({ ok: true, kind: "command" as const, isolated: true, durationMs: 61, exitCode: 0, commandLine: "node --test sales.test.cjs", stdoutTail: TAP, summary: "verify.run command: passed (exit 0)" })),
});

/** One delegate call of the tests task, its worker timing out right after its suite ran; the judge prompt captured. */
async function reviewAfterTimeout() {
  const dir = mkdtempSync(join(tmpdir(), "evidence-review-"));
  try {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    writeFileSync(join(dir, "sales.cjs"), PROGRAM);
    const prompts: string[] = [];
    const asked: ApprovalRequest[] = [];
    let minted = 0;
    let turns = 0;
    const d: FusionDelegateDeps = {
      // The worker writes its suite, runs it, then its clock ends it before any summary.
      runTurn: async (session, _m, options) => {
        // Only the first turn acts; any later one (a review pass) replies at once.
        if (turns++ > 0) return { session: createEmptySessionState({ id: session.id, workingDir: dir }), reason: "reply", stepCount: 1 } as RunTurnResult;
        options.eventHook?.({ type: "turn_started", turnIndex: 0 } as never);
        options.eventHook?.(ev({ type: "tool_call_parsed", call: { tool: "os.fs.write", args: { path: "sales.test.cjs", content: SUITE } } }));
        writeFileSync(join(dir, "sales.test.cjs"), SUITE);
        options.eventHook?.(ev({ type: "tool_call_executed", result: { tool: "os.fs.write", status: "ok", summary: "", details: {}, truncated: false } }));
        options.eventHook?.({ type: "step_finished", stepIndex: 0, summary: "", durationMs: 1 } as never);
        options.eventHook?.(ev({ type: "tool_call_parsed", call: { tool: "verify.run", args: WORKER_SPEC } }));
        options.eventHook?.(ev({ type: "tool_call_executed", result: { tool: "verify.run", status: "ok", summary: "verify.run command: passed (exit 0)", details: { exitCode: 0, stdoutTail: TAP }, truncated: false } }));
        options.eventHook?.({ type: "step_finished", stepIndex: 1, summary: "", durationMs: 1 } as never);
        await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
        return { session: createEmptySessionState({ id: session.id, workingDir: dir }), reason: "cancelled", stepCount: 2 } as RunTurnResult;
      },
      createEphemeralSession: (meta) => {
        minted += 1;
        return createEmptySessionState({ id: `${FUSION_WORKER_ID_PREFIX}${minted}`, workingDir: dir, metadata: { fusionWorker: { ...meta } } });
      },
      approvals: cliGate(asked),
      approvalRequired: true,
      emitEvent: () => {},
      workingDir: dir,
      slotManager: { poolSize: () => 4 },
      resolveRunMode: mode,
      workerSupportsSlotAffinity: () => false,
      warmWorkerBackend: async () => {},
      outputCharCap: 4000,
      logger,
      escalationComplete: async (call) => { prompts.push(call.prompt); return { content: ACCEPT }; },
      resolveFusionTeam: () => team(),
      runChecks: gateChecks,
    };
    const pending = buildFusionDelegateTool(d).run(
      { tasks: [{ id: "sales-tests", title: "Tests", instructions: "write the tests in sales.test.cjs", files: ["sales.test.cjs"] }], contract: { checks: [{ task: "sales-tests", ...CONTRACT_CHECK }] } },
      { workingDir: dir, sessionId: "s-plan", stepIndex: 0, signal: new AbortController().signal, project: projectOf(["sales-tests"]) },
    );
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    const result = await pending;
    const row = (result.details.tasks as Array<{ status: string; timedOutAfterRun?: true; review?: { decision: string } }>)[0]!;
    const sha = (f: string) => createHash("sha256").update(readFileSync(join(dir, f))).digest("hex").slice(0, 12);
    return { row, asked, prompt: prompts.find((p) => p.includes("strict acceptance judge")) ?? "", testsSha: sha("sales.test.cjs") };
  } finally {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the evidence the reviewer receives (issue #104)", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("the worker spelled the task's check as one command line: it is still its own check, so the timeout is reviewed", async () => {
    const { row, asked, prompt } = await reviewAfterTimeout();
    expect(asked).toEqual([]);
    expect(row.status).toBe("ok");
    expect(row.timedOutAfterRun).toBe(true);
    expect(prompt).toContain("verify.run (the task's own check): node --test sales.test.cjs — exit 0");
  });

  it("command, exit, the full TAP, all nine cases, the file versions and a test-to-criterion mapping", async () => {
    const { prompt, testsSha } = await reviewAfterTimeout();
    expect(prompt).toContain("node --test sales.test.cjs");
    expect(prompt).toMatch(/exit 0/);
    // The full TAP, every line of it.
    for (const line of TAP.split("\n")) expect(prompt, line).toContain(line);
    for (const name of NAMES) expect(prompt, name).toContain(`- ok: ${name}`);
    expect(prompt).toContain(`sales.test.cjs sha256 ${testsSha}`);
    // Tests against the brief's criteria, as far as names match; the unmatched said plainly.
    expect(prompt).toContain('"sums revenue per region" <- sums revenue per region');
    expect(prompt).toContain('"skips blank lines" <- skips blank lines');
    expect(prompt).toContain('"ignores __proto__ keys safely" <- ignores __proto__ keys');
    expect(prompt).toContain('"reports a malformed row on stderr" <- no test name matches it');
  });
});
