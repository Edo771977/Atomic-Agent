/**
 * Issue #87: a fan-out that fails inside (the delegate's catch path) keeps
 * its checkpoint for a resume; a resume later in the same turn imports
 * only the spend the turn's cap has not counted. Production accounting:
 * a request cap, worker requests settled through the request seam.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { FanoutScopeRegistry } from "../../approval/fanout-scope.js";
import type { RunTurnResult } from "../../agent/agent-loop.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import { FUSION_WORKER_ID_PREFIX } from "../../session/fusion-worker-session.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import type { ToolContext } from "../tool-registry.js";
import { buildFusionDelegateTool, type FusionDelegateDeps } from "./fusion-delegate.js";
import { FusionRunStore } from "./run-checkpoint.js";
import { FusionTurnBudget } from "./turn-budget.js";

const failNext = { value: false };
vi.mock("./worker-runner.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./worker-runner.js")>();
  return {
    ...real,
    runWorkerTasks: async (...args: Parameters<typeof real.runWorkerTasks>) => {
      const out = await real.runWorkerTasks(...args);
      if (failNext.value) {
        failNext.value = false;
        throw new Error("the runner broke after its workers finished");
      }
      return out;
    },
  };
});

const logger = new StructuredLogger({ level: "error", sinks: [] });
const mode = (): ResolvedRunMode => ({
  stored: "fusion", effective: "fusion", orchestratorProviderId: "openrouter", orchestratorModel: "big",
  workerProviderId: "cloud-worker", workerModel: "small", workers: 1, workersPinned: true, workerMaxSteps: 7,
  workerTimeoutMs: 60_000, primaryProviderId: "openrouter", degraded: null, turnBudgetUsd: 1,
});
const ctx = (): ToolContext => ({ workingDir: "/repo", sessionId: "s-parent", stepIndex: 0, signal: new AbortController().signal });
const priced = (promptTokens: number) => ({
  type: "llm_event",
  event: { type: "llm_completed", completion: { content: "", reasoningContent: "", stop: true, truncated: false, cacheHitTokens: 0, slotId: 0, modelId: "small", usage: { promptTokens, completionTokens: 0, totalTokens: promptTokens } } },
}) as never;

function deps(budget: FusionTurnBudget, store: FusionRunStore): FusionDelegateDeps & { turns: number } {
  let minted = 0;
  const d = {
    turns: 0,
    runTurn: async (_s: unknown, _m: string, options: Parameters<FusionDelegateDeps["runTurn"]>[2]) => {
      d.turns += 1;
      // The request seam settles $0.10; the priced event says $0.20.
      budget.reserveRequest("s-parent", 0.1).settle(0.1);
      options.eventHook?.(priced(200_000));
      return { session: createEmptySessionState({ id: "s-w", workingDir: "/repo" }), reason: "reply", stepCount: 1 } as RunTurnResult;
    },
    createEphemeralSession: (meta: never) => {
      minted += 1;
      return createEmptySessionState({ id: `${FUSION_WORKER_ID_PREFIX}${minted}`, workingDir: "/repo", metadata: { fusionWorker: { ...(meta as object) } } });
    },
    approvals: { setSessionPolicy: () => {}, clearSessionPolicy: () => {}, fanoutScopes: new FanoutScopeRegistry() },
    approvalRequired: false,
    emitEvent: () => {},
    workingDir: "/repo",
    slotManager: { poolSize: () => 4 },
    resolveRunMode: mode,
    workerSupportsSlotAffinity: () => false,
    warmWorkerBackend: async () => {},
    outputCharCap: 4000,
    logger,
    resolveWorkerPricing: () => ({ input: 1, output: 4, cacheRead: 0.1 }),
    turnBudget: budget,
    runCheckpoints: store,
    requestBudgetAccounting: true,
  } as unknown as FusionDelegateDeps & { turns: number };
  return d;
}

describe("the delegate's catch path and a resume in the same turn (issue #87)", () => {
  it("a fan-out that fails inside keeps its run; the resume counts only what the cap has not seen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "resume-catch-"));
    try {
      const store = new FusionRunStore({ dir });
      const tasks = [{ id: "t1", title: "t1", instructions: "do t1" }];
      const run = store.start({ sessionId: "s-parent", workingDir: "/repo", tasks, waveCount: 1, args: { tasks } });
      run.addSpend(0.6);
      run.finish("interrupted");
      const budget = new FusionTurnBudget();
      budget.begin("s-parent", 0, { usd: 1 });
      const tool = buildFusionDelegateTool(deps(budget, store));
      const counted = () => budget.check("s-parent", { usd: 1e-9 })!.spentUsd;
      failNext.value = true;
      const failed = await tool.run({ resume: run.runId }, ctx());
      expect(failed.details.reason).toBe("fan-out-failed");
      expect(store.load(run.runId)!.state).toBe("interrupted");
      // $0.60 carried + t1's $0.10 request; the checkpoint priced t1 at $0.20.
      expect(counted()).toBeCloseTo(0.7);
      expect(store.load(run.runId)!.spentUsd).toBeCloseTo(0.8);
      await tool.run({ resume: run.runId }, ctx());
      expect(counted()).toBeCloseTo(0.8);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
