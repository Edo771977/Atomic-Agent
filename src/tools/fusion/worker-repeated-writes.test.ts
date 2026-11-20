import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { AgentLoopEvent, RunTurnResult } from "../../agent/agent-loop.js";
import { FUSION_WORKER_ID_PREFIX, type FusionWorkerMeta } from "../../session/fusion-worker-session.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { describeReplan, renderReplanBlock } from "./replan.js";
import { REPEATED_WRITE_LIMIT } from "./worker-repeated-writes.js";
import { runWorkerTasks, type WorkerRunnerDeps } from "./worker-runner.js";

const REPO = resolve("/repo");
const parsed = (tool: string, args: Record<string, unknown>, batchIndex = 0): AgentLoopEvent => ({
  type: "llm_event",
  event: { type: "tool_call_parsed", call: { tool, args }, batchIndex, batchSize: 1 },
});
const executed = (tool: string, status: "ok" | "error", batchIndex = 0): AgentLoopEvent => ({
  type: "llm_event",
  event: { type: "tool_call_executed", result: { tool, status, summary: "", details: {}, truncated: false }, batchIndex, batchSize: 1 },
});
const finished = (stepIndex: number): AgentLoopEvent => ({ type: "step_finished", stepIndex, summary: "", durationMs: 1 });

type Hook = (event: AgentLoopEvent) => void;
/** One worker run of `script`; it may return early once `aborted()` says the runner stopped it. */
async function runScript(script: (hook: Hook, aborted: () => boolean) => void | "stopped") {
  let stopped = false;
  let minted = 0;
  const deps: WorkerRunnerDeps = {
    runTurn: async (_session, _message, options) => {
      options.eventHook!({ type: "turn_started", turnIndex: 0 });
      stopped = script(options.eventHook!, () => options.signal?.aborted === true) === "stopped";
      return { session: createEmptySessionState({ id: "s-w", workingDir: REPO }), reason: stopped ? "cancelled" : "reply", stepCount: 1 } as RunTurnResult;
    },
    createEphemeralSession: (meta: FusionWorkerMeta) => {
      minted += 1;
      return createEmptySessionState({ id: `${FUSION_WORKER_ID_PREFIX}${minted}`, workingDir: REPO, metadata: { fusionWorker: { ...meta } } });
    },
    approvals: { setSessionPolicy: () => {}, clearSessionPolicy: () => {} },
    emitEvent: () => {},
    workingDir: REPO,
  };
  const [result] = await runWorkerTasks(deps, {
    parentSessionId: "s-parent", providerId: "local-llama", workerModel: "qwen", workerMaxSteps: 40, workerTimeoutMs: 600_000,
    tasks: [{ id: "tests", title: "Tests", instructions: "write sales.test.cjs" }], maxWorkers: 1, signal: new AbortController().signal,
  });
  return { result: result!, stopped };
}
let stepNo = 0;
const step = (hook: Hook, tool: string, args: Record<string, unknown>, status: "ok" | "error" = "ok"): void => {
  hook(parsed(tool, args));
  hook(executed(tool, status));
  hook(finished(stepNo++));
};

describe("a stalled worker's last check is reported as it stands (issue #95 review)", () => {
  it("a check that passed before the file changed is not run since the last change; one after it names whether it covered the file", async () => {
    const before = await runScript((hook, aborted) => {
      step(hook, "os.fs.write", { path: "sales.test.cjs", content: "A" });
      step(hook, "verify.run", { type: "command", command: "node --test sales.test.cjs" });
      for (let i = 0; i < 10; i += 1) {
        if (aborted()) return "stopped";
        step(hook, "os.fs.write", { path: "sales.test.cjs", content: "B" });
      }
    });
    expect(before.stopped).toBe(true);
    expect(before.result.stalled?.lastCheck).toMatchObject({ ok: true, sinceLastChange: false });
    expect(before.result.error).toContain("last check not run since the last change");
    expect(before.result.error).not.toContain("last check passed");
    expect(before.result.error).not.toMatch(/usable/);
    expect(renderReplanBlock(describeReplan([before.result], () => 1, 2))).not.toMatch(/may already be usable/);
    // The same bytes rewritten after a passing check of another file: fresh, but not covering it.
    const other = await runScript((hook, aborted) => {
      step(hook, "os.fs.write", { path: "sales.test.cjs", content: "B" });
      step(hook, "verify.run", { type: "command", command: "node --test other.test.cjs" });
      for (let i = 0; i < 10; i += 1) {
        if (aborted()) return "stopped";
        step(hook, "os.fs.write", { path: "sales.test.cjs", content: "B" });
      }
    });
    expect(other.result.stalled?.lastCheck).toMatchObject({ ok: true, sinceLastChange: true, coversFile: false });
    expect(other.result.error).toContain("last check passed");
    expect(other.result.error).toContain("its spec does not name sales.test.cjs");
  });
});

describe("a worker that keeps writing the same bytes is stopped early (issue #95)", () => {
  it("stops after the identical rewrites and hands the director the file, its hash and the last check", async () => {
    const content = "const test = require('node:test');\ntest('sums', () => {});\n";
    const sha256 = createHash("sha256").update(content).digest("hex");
    let writes = 0;
    let stoppedEarly = false;
    let minted = 0;
    const deps: WorkerRunnerDeps = {
      runTurn: async (_session, _message, options) => {
        const hook = options.eventHook!;
        hook({ type: "turn_started", turnIndex: 0 });
        let step = 0;
        // A usable file, a passing check, then the same bytes again and again.
        hook(parsed("os.fs.write", { path: "sales.test.cjs", content }));
        hook(executed("os.fs.write", "ok"));
        writes += 1;
        hook(finished(step++));
        hook(parsed("verify.run", { type: "command", command: "node --test sales.test.cjs" }));
        hook(executed("verify.run", "ok"));
        hook(finished(step++));
        for (let i = 0; i < 20; i += 1) {
          if (options.signal?.aborted) {
            stoppedEarly = true;
            return { session: createEmptySessionState({ id: "s-w", workingDir: REPO }), reason: "cancelled", stepCount: step } as RunTurnResult;
          }
          hook(parsed("os.fs.write", { path: "./sales.test.cjs", content }));
          hook(executed("os.fs.write", "ok"));
          writes += 1;
          hook(finished(step++));
        }
        // Without the stop the worker would run on to its time limit.
        return { session: createEmptySessionState({ id: "s-w", workingDir: REPO }), reason: "max_steps", stepCount: step } as RunTurnResult;
      },
      createEphemeralSession: (meta: FusionWorkerMeta) => {
        minted += 1;
        return createEmptySessionState({ id: `${FUSION_WORKER_ID_PREFIX}${minted}`, workingDir: REPO, metadata: { fusionWorker: { ...meta } } });
      },
      approvals: { setSessionPolicy: () => {}, clearSessionPolicy: () => {} },
      emitEvent: () => {},
      workingDir: REPO,
    };
    const [result] = await runWorkerTasks(deps, {
      parentSessionId: "s-parent", providerId: "local-llama", workerModel: "qwen", workerMaxSteps: 40, workerTimeoutMs: 600_000,
      tasks: [{ id: "tests", title: "Tests", instructions: "write sales.test.cjs" }], maxWorkers: 1, signal: new AbortController().signal,
    });
    expect(stoppedEarly).toBe(true);
    expect(writes).toBe(1 + REPEATED_WRITE_LIMIT);
    expect(result).toMatchObject({
      status: "failed",
      failure: "stuck",
      stalled: { reason: "repeated identical writes", path: "sales.test.cjs", sha256, writes: 1 + REPEATED_WRITE_LIMIT, lastCheck: { ok: true } },
    });
    expect(result!.stalled!.lastCheck!.spec).toContain("node --test sales.test.cjs");
    expect(result!.error).toMatch(/^stalled: repeated identical writes/);
    expect(result!.error).toContain("sales.test.cjs");
    expect(result!.error).toContain(sha256.slice(0, 12));
    expect(result!.error).toContain("last check passed");
    expect(result!.stalled!.lastCheck).toMatchObject({ sinceLastChange: true, coversFile: true });
    // The director's replan names it, so it can verify the file or reassign the task.
    const block = renderReplanBlock(describeReplan([result!], () => 1, 2));
    expect(block).toContain("stalled: repeated identical writes");
    expect(block).toContain(sha256.slice(0, 12));
    expect(block).toMatch(/verify the named file/);
  });
});
