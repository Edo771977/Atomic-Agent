import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
 * Issue #102 item 2b: in the live run the director, after a planned task
 * kept ending without an accept, sent it again on `model: "orchestrator"`.
 * That worker is not the plan row's, so the approved plan no longer stood
 * for the fan-out and it asked the person, who could not answer in a
 * non-interactive run. The replan steering keeps a plan task on its row's
 * worker and id instead.
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
const row = (reviewer: string | null, worker = "local:small"): AssignmentRow => ({
  taskId: "t", title: "T", milestoneId: "m1", worker, reviewer, reason: "preset", basis: "preset", samples: 0, estCostUsd: null, estMs: null,
});
/** An approved project whose one row has `reviewer`; `byPerson`: the person picked it at the gate. */
const project = (reviewer: string | null, byPerson: boolean, worker?: string): ProjectState => {
  const brief: ProjectUpdate = { kind: "brief", brief: { what: "A game", users: "Kids", how: "HTML", successCriteria: ["Runs"] }, draftedAfterUntrusted: false };
  const plan: ProjectUpdate = { kind: "plan", milestones: [{ id: "m1", title: "Base", kind: "base" }], rows: [row(reviewer, worker)], detail: "compact" };
  const p = approve(up(approve(up(undefined, brief)), plan));
  return byPerson ? { ...p, plan: { ...p.plan!, rows: p.plan!.rows.map((r) => ({ ...r, reviewerByPerson: true as const })) } } : p;
};

async function run(p: ProjectState, task: Record<string, unknown>, hang: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "director-takeover-"));
  const prompts: ApprovalRequest[] = [];
  const gate: ApprovalGate = new ApprovalGate({
    level: 1,
    emit: (req) => {
      prompts.push(req);
      // Nobody to answer: a non-interactive run declines.
      queueMicrotask(() => gate.resolve({ approvalId: req.approvalId, approved: false }));
    },
  });
  let minted = 0;
  const d: FusionDelegateDeps = {
    runTurn: async (session, _message, options) => {
      writeFileSync(join(dir, "a.txt"), "done");
      if (hang) await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return { session: createEmptySessionState({ id: session.id, workingDir: dir }), reason: hang ? "cancelled" : "reply", stepCount: 1 } as RunTurnResult;
    },
    createEphemeralSession: (meta) => {
      minted += 1;
      return createEmptySessionState({ id: `${FUSION_WORKER_ID_PREFIX}${minted}`, workingDir: dir, metadata: { fusionWorker: { ...meta } } });
    },
    approvals: gate,
    approvalRequired: true,
    emitEvent: () => {},
    workingDir: dir,
    slotManager: { poolSize: () => 4 },
    resolveRunMode: mode,
    workerSupportsSlotAffinity: () => false,
    warmWorkerBackend: async () => {},
    outputCharCap: 4000,
    logger,
    escalationComplete: async () => ({ content: ACCEPT }),
    resolveFusionTeam: () => team(),
  };
  const pending = buildFusionDelegateTool(d).run(
    { tasks: [{ id: "t", title: "T", instructions: "write a.txt", files: ["a.txt"], ...task }] },
    { workingDir: dir, sessionId: "s-plan", stepIndex: 0, signal: new AbortController().signal, project: p },
  );
  if (hang) await vi.advanceTimersByTimeAsync(60 * 60_000);
  const result = await pending;
  rmSync(dir, { recursive: true, force: true });
  return { prompts, result };
}

describe("a director takeover of a plan task (issue #102)", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("on model orchestrator it leaves the approved plan and asks the person; on the row's worker it does not", async () => {
    const p = project("cli-b:model-r", false);
    expect((await run(p, {}, false)).prompts).toHaveLength(0);
    const takeover = await run(p, { model: "orchestrator" }, false);
    expect(takeover.prompts.map((r) => r.category)).toEqual(["fusion_fanout"]);
    // Issue #104: the refusal says which condition left the plan, and how to send it so it is covered.
    expect(takeover.result.summary).toContain("This fan-out needs the person's approval: the approved plan does not cover it (task t would run on api-a:model-a, but its plan row names local:small).");
    // Issue #104 review: it names what broke coverage, and prescribes no task id to borrow.
    const off = await run(p, { id: "extra-work" }, false);
    expect(off.result.summary).toContain("task extra-work is not a row of the plan");
    expect(off.result.summary).not.toMatch(/keep the plan row's task id|Send each plan task under its plan task id/);
  });

  it("a plan task that did not close is steered to its row's worker and id, not to another model", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const { result, prompts } = await run(project("cli-b:model-r", false), {}, true);
    expect(prompts).toHaveLength(0);
    expect(result.summary).toContain("REPLAN REQUIRED");
    expect(result.summary).toContain("keep its plan task id (a plan task is never split)");
    expect(result.summary).not.toMatch(/continuation ids `t\.a`/);
  });

  it("a plan row the orchestrator works is steered back to the orchestrator, by its row's member (issue #102 review)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const { result, prompts } = await run(project("cli-b:model-r", false, "api-a:model-a"), { model: "orchestrator" }, true);
    expect(prompts).toHaveLength(0);
    expect(result.summary).toContain("re-delegate it on the plan row's worker (the orchestrator, `model: \"orchestrator\"`)");
  });
});
