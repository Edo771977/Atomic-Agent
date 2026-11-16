import { describe, expect, it } from "vitest";

import type { AgentLoopEvent, RunTurnResult } from "../../agent/agent-loop.js";
import type { FusionWorkerMeta } from "../../session/fusion-worker-session.js";
import { FUSION_WORKER_ID_PREFIX } from "../../session/fusion-worker-session.js";
import type { SessionState } from "../../session/session-state.js";
import { createEmptySessionState } from "../../session/session-state.js";
import type { DelegateTask } from "./delegate-args.js";
import { runWorkerTasks, type RunWorkerTasksOptions, type WorkerRunnerDeps } from "./worker-runner.js";
import { formatWatchSteer, type WatchClock, type WatchJudgeCall } from "./worker-watch.js";

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
    say: (text: string) => emit?.(llm({ type: "assistant_reply", text })),
    parsed: (tool: string) =>
      emit?.(llm({ type: "tool_call_parsed", batchIndex: 0, call: { tool, args: {} } })),
    executed: (tool: string) =>
      emit?.(llm({
        type: "tool_call_executed",
        batchIndex: 0,
        result: { tool, status: "ok", summary: `${tool} ran`, details: {} },
      })),
    finish: () => finish?.(),
  };
}

const TASK: DelegateTask = { id: "t1", title: "T1", instructions: "edit src/a.ts in place" };

function options(
  _h: ReturnType<typeof harness>,
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
    // The next request's first token: the worker is answering again.
    h.delta("y");
    await c.tick();
    expect(prompts).toEqual([]);
    // Two quiet intervals: the judge reads the counts the probe saw.
    await c.tick();
    await c.tick();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("steps finished: 1 (+0)");
    expect(prompts[0]).toContain("files changed: 1 (+0)");
    expect(prompts[0]).toMatch(/output tokens: 101 \(\+0\)/);
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

describe("a worker that is waiting, not stalled (issue #43)", () => {
  const stuckJudge = () => {
    const calls: string[] = [];
    const judge: WatchJudgeCall = async ({ prompt }) => {
      calls.push(prompt);
      return { kind: "answer", content: '{"state":"stuck","hint":null}' };
    };
    return { calls, judge };
  };

  it("does not judge while one long tool call runs (a build, the checks, a shell command)", async () => {
    const h = harness();
    const c = handClock();
    const { calls, judge } = stuckJudge();
    const run = runWorkerTasks(h.deps, options(h, c.clock, judge));
    await flush();
    h.delta("x");
    h.parsed("shell.exec");
    for (let i = 0; i < 3; i += 1) await c.tick();
    expect(calls).toEqual([]);
    // The call came back: quiet intervals count again from here.
    h.executed("shell.exec");
    h.finish();
    const [row] = await run;
    expect(row!.status).toBe("ok");
    expect(row!.watch).toMatchObject({ checks: 3, judgeCalls: 0, stopped: false });
  });

  it("does not judge while the next request waits for its first token (slow prompt processing)", async () => {
    const h = harness();
    const c = handClock();
    const { calls, judge } = stuckJudge();
    const run = runWorkerTasks(h.deps, options(h, c.clock, judge));
    await flush();
    h.delta("x");
    h.step();
    for (let i = 0; i < 3; i += 1) await c.tick();
    expect(calls).toEqual([]);
    h.finish();
    const [row] = await run;
    expect(row!.status).toBe("ok");
    expect(row!.watch).toMatchObject({ checks: 3, judgeCalls: 0 });
  });
});

describe("a worker that streams (issue #43)", () => {
  it("steady streaming costs nothing; a trickle is judged with its tail", async () => {
    const h = harness();
    const c = handClock();
    const prompts: string[] = [];
    const judge: WatchJudgeCall = async ({ prompt }) => {
      prompts.push(prompt);
      return { kind: "answer", content: '{"state":"progressing","hint":null}' };
    };
    const run = runWorkerTasks(h.deps, options(h, c.clock, judge));
    await flush();
    for (let i = 0; i < 3; i += 1) {
      h.delta("y".repeat(800));
      await c.tick();
    }
    expect(prompts).toEqual([]);
    h.delta("now I will re-read src/a.ts");
    await c.tick();
    await c.tick();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("now I will re-read src/a.ts");
    h.finish();
    await run;
  });
});

describe("what the watch does with the judge's answer (issue #43)", () => {
  it("delivers a looping hint to the worker through its steering inbox", async () => {
    const h = harness();
    const c = handClock();
    const run = runWorkerTasks(h.deps, options(h, c.clock, async () => ({
      kind: "answer",
      content: '{"state":"looping","hint":"stop re-reading src/a.ts; write the fix"}',
    })));
    await flush();
    h.delta("x");
    await c.tick();
    await c.tick();
    expect(h.steered).toEqual([formatWatchSteer("model-r", "looping", "stop re-reading src/a.ts; write the fix")]);
    h.finish();
    const [row] = await run;
    expect(row!.status).toBe("ok");
    expect(row!.watch).toMatchObject({ hints: 1, stopped: false });
  });

  it("stops a stuck worker cleanly: failed, failure stuck, the watch's record, no timer left", async () => {
    const h = harness();
    const c = handClock();
    const run = runWorkerTasks(h.deps, options(h, c.clock, async () => ({ kind: "answer", content: '{"state":"stuck","hint":null}' })));
    await flush();
    h.delta("x");
    await c.tick();
    await c.tick();
    const [row] = await run;
    expect(h.signal()?.aborted).toBe(true);
    expect(row!.status).toBe("failed");
    expect(row!.failure).toBe("stuck");
    expect(row!.error).toMatch(/^stuck: the watch \(model-r\) judged the worker stuck/);
    expect(row!.watch).toMatchObject({ judgeCalls: 1, stopped: true });
    expect(c.live()).toBe(false);
  });
});

describe("the watch and the worker's self-check (issue #43)", () => {
  it("does not judge while the worker's own checks run after its reply", async () => {
    const h = harness();
    const c = handClock();
    let release: (() => void) | undefined;
    const runChecks = (async (specs: readonly Record<string, unknown>[]) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ok: true, results: specs.map(() => ({ ok: true, summary: "verify.run command: ok" })) };
    }) as unknown as NonNullable<WorkerRunnerDeps["runChecks"]>;
    let calls = 0;
    const run = runWorkerTasks({ ...h.deps, runChecks }, options(h, c.clock, async () => {
      calls += 1;
      return { kind: "answer", content: '{"state":"stuck","hint":null}' };
    }, { contract: { checks: [{ task: "t1", kind: "command", cmd: "node", args: ["t.js"] }] } }));
    await flush();
    h.delta("x");
    h.say("done");
    h.finish();
    for (let i = 0; i < 10 && release === undefined; i += 1) await flush();
    expect(release).toBeDefined();
    for (let i = 0; i < 3; i += 1) await c.tick();
    expect(calls).toBe(0);
    release!();
    const [row] = await run;
    expect(row!.status).toBe("ok");
  });
});
