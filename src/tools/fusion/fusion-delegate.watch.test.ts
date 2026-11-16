import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FanoutScopeRegistry } from "../../approval/fanout-scope.js";
import type { AgentLoopEvent, RunTurnResult } from "../../agent/agent-loop.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import { FUSION_WORKER_ID_PREFIX } from "../../session/fusion-worker-session.js";
import { createEmptySessionState, type SessionState } from "../../session/session-state.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import type { DelegateTask } from "./delegate-args.js";
import type { EscalationComplete } from "./escalation.js";
import { buildFusionDelegateTool, type FusionDelegateDeps } from "./fusion-delegate.js";
import type { FusionTeamContext } from "./team-routing.js";
import type { WatchClock } from "./worker-watch.js";

/**
 * The watch on a team run's workers, wired in `fusion.delegate` (issue
 * #43): who judges (the task's reviewer, else the director, on its own
 * model), the interval (the task's `watchMinutes`, else the config's),
 * the budget guard and the cap.
 */

const logger = new StructuredLogger({ level: "error", sinks: [] });

const REVIEWED: FusionTeamContext = {
  team: { directors: ["api-a:model-a"], workers: ["local:small"], reviewers: ["cli-b:model-r"] },
  fusion: { workerProvider: "local" },
  familyOf: (m) => (m.providerId === "local" ? "local" : "openai"),
  reachable: () => true,
  pinsModel: (id) => id !== "local",
};
const DIRECTED: FusionTeamContext = {
  ...REVIEWED,
  team: { directors: ["api-a:model-a"], workers: ["local:small"] },
};

function mode(over: Partial<ResolvedRunMode> = {}): ResolvedRunMode {
  return {
    stored: "fusion",
    effective: "fusion",
    orchestratorProviderId: "api-a",
    orchestratorModel: "model-a",
    director: { providerId: "api-a", model: "model-a", ref: "api-a:model-a" },
    workerProviderId: "local",
    workerModel: "small",
    workers: 1,
    workersPinned: true,
    workerMaxSteps: 7,
    workerTimeoutMs: 600_000,
    primaryProviderId: "api-a",
    degraded: null,
    judge: null,
    ...over,
  } as ResolvedRunMode;
}

interface Call {
  providerId: string;
  model?: string;
  prompt: string;
}

/** A clock the test ticks by hand, remembering each interval asked for. */
function handClock() {
  let pending: (() => void) | undefined;
  const intervals: number[] = [];
  const clock: WatchClock = {
    setTimeout: (fn, ms) => {
      pending = fn;
      intervals.push(ms);
      return intervals.length;
    },
    clearTimeout: () => {
      pending = undefined;
    },
  };
  return {
    clock,
    intervals,
    live: () => pending !== undefined,
    tick: async () => {
      const fn = pending;
      pending = undefined;
      fn?.();
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

async function run(input: {
  context: FusionTeamContext | undefined;
  watchAnswer?: string;
  tasks?: DelegateTask[];
  runOver?: Partial<ResolvedRunMode>;
  over?: Partial<FusionDelegateDeps>;
  /** Ticks after the worker was served, before it replies. */
  ticks?: number;
  /** Runs once the worker is running, before the ticks. */
  beforeTicks?: () => void;
  contract?: Record<string, unknown>;
  /** The reviewer's answers in turn; then accept. */
  reviewAnswers?: string[];
}) {
  const dir = mkdtempSync(join(tmpdir(), "fusion-watch-"));
  const c = handClock();
  const calls: Call[] = [];
  const complete: EscalationComplete = async (call) => {
    calls.push({ providerId: call.providerId, ...(call.model === undefined ? {} : { model: call.model }), prompt: call.prompt });
    if (call.prompt.startsWith("You watch a worker")) {
      return { content: input.watchAnswer ?? '{"state":"progressing","hint":null}', usage: { promptTokens: 1000, completionTokens: 100, totalTokens: 1100 } };
    }
    return { content: input.reviewAnswers?.shift() ?? JSON.stringify({ decision: "accept", issues: [] }) };
  };
  let minted = 0;
  const started: Array<() => Promise<void>> = [];
  const d = {
    runTurn: (session: SessionState, _message: string, options: { eventHook?: (e: AgentLoopEvent) => void; signal?: AbortSignal }) =>
      new Promise<RunTurnResult>((resolve) => {
        options.eventHook?.({ type: "llm_event", event: { type: "assistant_delta", text: "thinking" } } as unknown as AgentLoopEvent);
        const done = (): void => {
          writeFileSync(join(dir, "a.txt"), "done");
          resolve({ session, reason: "reply", stepCount: 1 } as RunTurnResult);
        };
        options.signal?.addEventListener("abort", () => resolve({ session, reason: "cancelled", stepCount: 0 } as RunTurnResult));
        started.push(async () => {
          input.beforeTicks?.();
          for (let i = 0; i < (input.ticks ?? 0); i += 1) await c.tick();
          done();
        });
      }),
    createEphemeralSession: (meta: never) => {
      minted += 1;
      return createEmptySessionState({
        id: `${FUSION_WORKER_ID_PREFIX}${minted}`,
        workingDir: dir,
        metadata: { fusionWorker: { ...(meta as object) } },
      });
    },
    approvals: { setSessionPolicy: () => {}, clearSessionPolicy: () => {}, fanoutScopes: new FanoutScopeRegistry() },
    approvalRequired: false,
    emitEvent: () => {},
    workingDir: dir,
    slotManager: { poolSize: () => 4 },
    resolveRunMode: () => mode(input.runOver),
    workerSupportsSlotAffinity: () => false,
    warmWorkerBackend: async () => {},
    outputCharCap: 8000,
    logger,
    escalationComplete: complete,
    resolveFusionTeam: () => input.context,
    watchClock: c.clock,
    watchRandom: () => 0,
    ...input.over,
  } as unknown as FusionDelegateDeps;
  const pending = buildFusionDelegateTool(d).run(
    {
      tasks: input.tasks ?? [{ id: "t", title: "T", instructions: "write a.txt" }],
      ...(input.contract === undefined ? {} : { contract: input.contract }),
    },
    { workingDir: dir, sessionId: "s-w", stepIndex: 0, signal: new AbortController().signal },
  );
  // Let each worker start, then drive it.
  for (let i = 0; i < 50 && started.length === 0; i += 1) await new Promise((r) => setTimeout(r, 0));
  // Drive every run of a worker, review passes too, until the call ends.
  let settled = false;
  void pending.finally(() => {
    settled = true;
  });
  while (!settled) {
    if (started.length > 0) await started.shift()!();
    else await new Promise((r) => setTimeout(r, 0));
  }
  const result = await pending;
  rmSync(dir, { recursive: true, force: true });
  const rows = result.details.tasks as Array<Record<string, unknown>>;
  return { result, calls, watchCalls: calls.filter((call) => call.prompt.startsWith("You watch a worker")), clock: c, rows };
}

describe("who watches a team run's worker (issue #43)", () => {
  it("the task's reviewer, on its own model, after two quiet intervals", async () => {
    const { watchCalls, clock, rows } = await run({ context: REVIEWED, ticks: 2 });
    expect(watchCalls).toEqual([expect.objectContaining({ providerId: "cli-b", model: "model-r" })]);
    expect(clock.intervals[0]).toBe(5 * 60_000);
    expect(rows[0]!.watch).toMatchObject({ checks: 2, judgeCalls: 1, judge: "model-r" });
  });

  it("the director when the task has no reviewer", async () => {
    const { watchCalls, rows } = await run({ context: DIRECTED, ticks: 2 });
    expect(watchCalls).toEqual([expect.objectContaining({ providerId: "api-a", model: "model-a" })]);
    expect(rows[0]!.watch).toMatchObject({ judge: "model-a" });
  });

  it("the director when team.review is off, as for the review itself", async () => {
    const { watchCalls, rows } = await run({ context: { ...REVIEWED, team: { ...REVIEWED.team, review: "off" } }, ticks: 2 });
    expect(watchCalls).toEqual([expect.objectContaining({ providerId: "api-a", model: "model-a" })]);
    expect(rows[0]!.watch).toMatchObject({ judge: "model-a" });
  });

  it("every task's own watchMinutes, else team.watchEveryMinutes", async () => {
    const own = await run({ context: DIRECTED, tasks: [{ id: "t", title: "T", instructions: "x", watchMinutes: 12 }] });
    expect(own.clock.intervals[0]).toBe(12 * 60_000);
    const configured = await run({ context: { ...DIRECTED, team: { ...DIRECTED.team, watchEveryMinutes: 2 } } });
    expect(configured.clock.intervals[0]).toBe(2 * 60_000);
  });

  it("no watch with watchMinutes 0, team.watchEveryMinutes 0, or no team", async () => {
    for (const input of [
      { context: DIRECTED, tasks: [{ id: "t", title: "T", instructions: "x", watchMinutes: 0 }] },
      { context: { ...DIRECTED, team: { ...DIRECTED.team, watchEveryMinutes: 0 } } },
      { context: undefined },
    ]) {
      const { clock, rows } = await run({ ...input, ticks: 3 });
      expect(clock.intervals).toEqual([]);
      expect(rows[0]!.watch).toBeUndefined();
    }
  });
});

describe("the watch's cost guard (issue #43)", () => {
  it("at most team.watchMaxChecks judge calls per task", async () => {
    const { watchCalls, rows } = await run({
      context: { ...DIRECTED, team: { ...DIRECTED.team, watchMaxChecks: 1 } },
      ticks: 6,
    });
    expect(watchCalls).toHaveLength(1);
    expect(String(rows[0]!.notes)).toContain("watch: 1 judge call used; not asked again");
  });

  it("the cap is the task's, across its review passes", async () => {
    const { watchCalls, calls, rows } = await run({
      context: { ...REVIEWED, team: { ...REVIEWED.team, watchMaxChecks: 1, reviewPasses: 1 } },
      ticks: 2,
      reviewAnswers: [JSON.stringify({ decision: "needs-changes", issues: [{ item: null, severity: "blocker", file: null, why: "redo it" }] })],
    });
    // Two runs of the task (the first and its review pass), one judge call between them.
    expect(calls.filter((c) => !c.prompt.startsWith("You watch a worker")).length).toBeGreaterThanOrEqual(2);
    expect(watchCalls).toHaveLength(1);
    expect(String(rows[0]!.notes)).toContain("watch: 1 judge call used; not asked again");
  });

  it("under a $ cap only a priced judge is asked; an unpriced one is skipped and noted", async () => {
    const { watchCalls, rows } = await run({ context: DIRECTED, ticks: 2, runOver: { turnBudgetUsd: 5 } });
    expect(watchCalls).toEqual([]);
    expect(String(rows[0]!.notes)).toMatch(/watch: judge not asked: .*priced/);
  });

  it("a priced judge under a $ cap is asked and its spend counts in the turn's", async () => {
    const pricing = { input: 3, output: 15 };
    const { watchCalls, result } = await run({
      context: DIRECTED,
      ticks: 2,
      runOver: { turnBudgetUsd: 5 },
      over: { resolveWorkerPricing: (provider: string) => (provider === "api-a" ? pricing : undefined) },
    });
    expect(watchCalls).toHaveLength(1);
    // 1000 in, 100 out at $3 / $15 per million.
    expect(result.details.judgeSpendUsd).toBeCloseTo(0.0045, 6);
  });

  it("spreads parallel watches: the first tick waits a bounded, per-task jitter", async () => {
    const { clock } = await run({ context: DIRECTED, ticks: 2, over: { watchRandom: () => 0.5 } });
    expect(clock.intervals[0]).toBe(5 * 60_000 + 30_000 / 2);
    expect(clock.intervals[1]).toBe(5 * 60_000);
  });

  it("reserves a judge call's worst case before it is sent under a $ cap", async () => {
    const pricing = { input: 3, output: 15 };
    // The reply alone could cost 200 output tokens at $15 per million: $0.003.
    const { watchCalls, rows } = await run({
      context: DIRECTED,
      ticks: 2,
      runOver: { turnBudgetUsd: 0.003 },
      over: { resolveWorkerPricing: () => pricing },
    });
    expect(watchCalls).toEqual([]);
    expect(String(rows[0]!.notes)).toMatch(/watch: judge not asked: .*worst case/);
  });

  it("not asked once the turn's budget is reached", async () => {
    let spent = 0;
    const pricing = { input: 3, output: 15 };
    const { watchCalls } = await run({
      context: DIRECTED,
      ticks: 2,
      runOver: { turnBudgetUsd: 5 },
      beforeTicks: () => {
        spent = 10;
      },
      over: {
        resolveWorkerPricing: () => pricing,
        orchestratorTurnSpendUsd: () => spent,
      },
    });
    expect(watchCalls).toEqual([]);
  });
});

describe("a task the watch stopped goes to the director (issue #43)", () => {
  it("in its own replan bucket, with autoReplan off too, and never as pending", async () => {
    for (const autoReplan of [0, 2]) {
      const { result, rows } = await run({ context: DIRECTED, ticks: 2, watchAnswer: '{"state":"stuck","hint":null}', runOver: { autoReplan } });
      expect(rows[0]).toMatchObject({ status: "failed", failure: "stuck" });
      const replan = result.details.replan as { pending: unknown[]; exhausted: unknown[]; stuck: Array<{ id: string; redelegate?: false }> };
      expect(replan.pending).toEqual([]);
      expect(replan.exhausted).toEqual([]);
      expect(replan.stuck).toEqual([expect.objectContaining({ id: "t", ...(autoReplan === 0 ? { redelegate: false } : {}) })]);
      expect(result.summary).toContain("STOPPED BY THE WATCH");
    }
  });

  it("a dependent of a stuck task is held without forcing a replan", async () => {
    const { result } = await run({
      context: DIRECTED,
      ticks: 2,
      watchAnswer: '{"state":"stuck","hint":null}',
      runOver: { autoReplan: 2 },
      tasks: [
        { id: "core", title: "Core", instructions: "x" },
        { id: "ui", title: "UI", instructions: "y" },
      ],
      contract: {
        provides: [{ task: "core", kind: "other", name: "core-ready" }],
        requires: [{ task: "ui", name: "core-ready" }],
      },
    });
    const replan = result.details.replan as { pending: Array<{ id: string; awaitsReview?: string[] }>; stuck: Array<{ id: string }> };
    expect(replan.stuck.map((t) => t.id)).toEqual(["core"]);
    expect(replan.pending).toEqual([expect.objectContaining({ id: "ui", awaitsReview: ["core"] })]);
    expect(result.summary).not.toContain("REPLAN REQUIRED");
  });
});

describe("the watch on the record (issue #43)", () => {
  it("details.watch per task and the outcome log's counts, no text", async () => {
    const written: Array<Record<string, unknown>> = [];
    const outcomeLog = { append: (records: readonly unknown[]) => { written.push(...(records as Array<Record<string, unknown>>)); } };
    const { result } = await run({
      context: DIRECTED,
      ticks: 2,
      watchAnswer: '{"state":"looping","hint":"SECRET-HINT write a.txt"}',
      over: { outcomeLog } as Partial<FusionDelegateDeps>,
    });
    expect(result.details.watch).toEqual({ t: { checks: 2, judgeCalls: 1, hints: 0, stopped: false, judge: "model-a" } });
    const task = written.find((r) => r.type === "task")!;
    expect(task.watch).toEqual({ checks: 2, judgeCalls: 1, hints: 0, stopped: false, judge: "model-a" });
    expect(JSON.stringify(written)).not.toContain("SECRET-HINT");
  });
});
