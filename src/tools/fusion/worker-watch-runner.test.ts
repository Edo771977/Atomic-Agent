import { describe, expect, it } from "vitest";

import type { AgentLoopEvent, RunTurnResult } from "../../agent/agent-loop.js";
import type { FusionWorkerMeta } from "../../session/fusion-worker-session.js";
import { FUSION_WORKER_ID_PREFIX } from "../../session/fusion-worker-session.js";
import type { SessionState } from "../../session/session-state.js";
import { createEmptySessionState } from "../../session/session-state.js";
import type { DelegateTask } from "./delegate-args.js";
import { runWorkerTasks, type RunWorkerTasksOptions, type WorkerRunnerDeps } from "./worker-runner.js";
import type { WatchClock, WatchJudgeCall } from "./worker-watch.js";

/**
 * The watch on a running worker inside the runner (issue #43): the probe
 * reads the worker's own event stream (steps, tokens, files written,
 * first token), the timer lives only while the turn runs, and the row
 * carries the counts.
 */

type TurnOptions = Parameters<WorkerRunnerDeps["runTurn"]>[2];

const flush = () => new Promise((r) => setTimeout(r, 0));

/** A clock the test ticks by hand. */
function handClock() {
  let pending: (() => void) | undefined;
  let armed = 0;
  let cleared = 0;
  const clock: WatchClock = {
    setTimeout: (fn) => {
      pending = fn;
      armed += 1;
      return armed;
    },
    clearTimeout: () => {
      pending = undefined;
      cleared += 1;
    },
  };
  return {
    clock,
    tick: async () => {
      const fn = pending;
      pending = undefined;
      fn?.();
      await flush();
    },
    live: () => pending !== undefined,
    counts: () => ({ armed, cleared }),
  };
}

/** A worker turn the test drives event by event. */
function harness() {
  let emit: ((event: AgentLoopEvent) => void) | undefined;
  let finish: (() => void) | undefined;
  let signal: AbortSignal | undefined;
  const steered: string[] = [];
  const deps: WorkerRunnerDeps = {
    runTurn: (session: SessionState, _message: string, options: TurnOptions) =>
      new Promise<RunTurnResult>((resolve) => {
        emit = options.eventHook;
        signal = options.signal;
        finish = () => resolve({ session, reason: "reply", stepCount: 1 } as RunTurnResult);
        options.signal?.addEventListener("abort", () =>
          resolve({ session, reason: "cancelled", stepCount: 0 } as RunTurnResult),
        );
      }),
    createEphemeralSession: (meta: FusionWorkerMeta) =>
      createEmptySessionState({
        id: `${FUSION_WORKER_ID_PREFIX}1`,
        workingDir: "/repo",
        metadata: { fusionWorker: { ...meta } },
      }),
    approvals: { setSessionPolicy: () => {}, clearSessionPolicy: () => {} },
    emitEvent: () => {},
    workingDir: "/repo",
    steerWorker: (_id, text) => {
      steered.push(text);
      return true;
    },
  };
  const llm = (event: unknown): AgentLoopEvent => ({ type: "llm_event", event } as unknown as AgentLoopEvent);
  return {
    deps,
    steered,
    signal: () => signal,
    delta: (text: string) => emit?.(llm({ type: "assistant_delta", text })),
    step: () => emit?.({ type: "step_finished", stepIndex: 0, summary: "", durationMs: 1 } as AgentLoopEvent),
    read: (n: number) =>
      emit?.(llm({
        type: "tool_call_executed",
        batchIndex: 0,
        result: { tool: "os.fs.read", status: "ok", summary: "read src/a.ts", details: { path: "src/a.ts", n } },
      })),
    write: (path: string) =>
      emit?.(llm({
        type: "tool_call_executed",
        batchIndex: 0,
        result: { tool: "os.fs.write", status: "ok", summary: `wrote ${path}`, details: { path, existed: true } },
      })),
    finish: () => finish?.(),
  };
}

const TASK: DelegateTask = { id: "t1", title: "T1", instructions: "edit src/a.ts in place" };

function options(
  h: ReturnType<typeof harness>,
  clock: WatchClock,
  judge: WatchJudgeCall,
  extra: Partial<RunWorkerTasksOptions> = {},
): RunWorkerTasksOptions {
  return {
    parentSessionId: "s-parent",
    providerId: "cloud",
    workerModel: "model-w",
    workerMaxSteps: 20,
    workerTimeoutMs: 600_000,
    maxWorkers: 1,
    tasks: [TASK],
    signal: new AbortController().signal,
    watch: (id) =>
      id === "t1" ? { intervalMs: 60_000, maxJudgeCalls: 3, judgeLabel: "model-r", judge, clock } : undefined,
    ...extra,
  };
}

describe("the watch inside the worker runner (issue #43)", () => {
  it("probes steps, streamed tokens and files changed, and asks nothing while the worker writes", async () => {
    const h = harness();
    const c = handClock();
    const prompts: string[] = [];
    const judge: WatchJudgeCall = async ({ prompt }) => {
      prompts.push(prompt);
      return { kind: "answer", content: '{"state":"progressing","hint":null}' };
    };
    const run = runWorkerTasks(h.deps, options(h, c.clock, judge));
    await flush();
    expect(c.live()).toBe(true);
    h.delta("x".repeat(400));
    h.write("src/a.ts");
    h.step();
    await c.tick();
    expect(prompts).toEqual([]);
    // Two quiet intervals: the judge reads the counts the probe saw.
    await c.tick();
    await c.tick();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("steps finished: 1 (+0)");
    expect(prompts[0]).toContain("files changed: 1 (+0)");
    expect(prompts[0]).toMatch(/output tokens: 100 \(\+0\)/);
    expect(prompts[0]).toContain("edit src/a.ts in place");
    h.finish();
    const [row] = await run;
    expect(c.live()).toBe(false);
    expect(row!.watch).toEqual({ checks: 3, judgeCalls: 1, hints: 0, stopped: false, judge: "model-r" });
  });

  it("asks at once when the steps since the last check look stalled", async () => {
    const h = harness();
    const c = handClock();
    let calls = 0;
    const run = runWorkerTasks(h.deps, options(h, c.clock, async () => {
      calls += 1;
      return { kind: "answer", content: '{"state":"progressing","hint":null}' };
    }));
    await flush();
    for (let i = 0; i < 3; i += 1) {
      h.read(1);
      h.step();
    }
    await c.tick();
    expect(calls).toBe(1);
    h.finish();
    await run;
  });

  it("does not judge a worker the server has not answered yet", async () => {
    const h = harness();
    const c = handClock();
    let calls = 0;
    const run = runWorkerTasks(h.deps, options(h, c.clock, async () => {
      calls += 1;
      return { kind: "answer", content: '{"state":"stuck","hint":null}' };
    }));
    await flush();
    for (let i = 0; i < 4; i += 1) await c.tick();
    expect(calls).toBe(0);
    h.finish();
    const [row] = await run;
    expect(row!.watch?.checks).toBe(4);
  });

  it("starts no watch for a task without a plan, and clears the timer when the turn is cancelled", async () => {
    const h = harness();
    const c = handClock();
    const run = runWorkerTasks(h.deps, options(h, c.clock, async () => ({ kind: "failed", reason: "x" }), { watch: () => undefined }));
    await flush();
    expect(c.counts().armed).toBe(0);
    h.finish();
    const [row] = await run;
    expect(row!.watch).toBeUndefined();

    const h2 = harness();
    const c2 = handClock();
    const turn = new AbortController();
    const run2 = runWorkerTasks(h2.deps, options(h2, c2.clock, async () => ({ kind: "failed", reason: "x" }), { signal: turn.signal }));
    await flush();
    expect(c2.live()).toBe(true);
    turn.abort();
    await run2;
    expect(c2.live()).toBe(false);
  });
});
