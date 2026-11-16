import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";

import { ApprovalGate, type ApprovalRequest } from "../../approval/approval-gate.js";
import { FanoutScopeRegistry } from "../../approval/fanout-scope.js";
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
import type { ToolContext } from "../tool-registry.js";
import { buildFusionDelegateTool, type FusionDelegateDeps } from "./fusion-delegate.js";

const REPO = resolve("/repo");
const NOW = 1_700_000_000_000;
const logger = new StructuredLogger({ level: "error", sinks: [] });

function fusionMode(): ResolvedRunMode {
  return {
    stored: "fusion", effective: "fusion", orchestratorProviderId: "openrouter", orchestratorModel: "big",
    workerProviderId: "local-llama", workerModel: "small", workers: 3, workersPinned: true,
    workerMaxSteps: 7, workerTimeoutMs: 60_000, primaryProviderId: "openrouter", degraded: null,
  };
}

function gateAnswering() {
  const prompts: ApprovalRequest[] = [];
  const gate: ApprovalGate = new ApprovalGate({
    level: 1,
    emit: (req) => {
      prompts.push(req);
      queueMicrotask(() => gate.resolve({ approvalId: req.approvalId, approved: true }));
    },
  });
  return { gate, prompts };
}

function deps(over: Partial<FusionDelegateDeps> = {}): FusionDelegateDeps {
  let minted = 0;
  return {
    runTurn: vi.fn(async (): Promise<RunTurnResult> => ({
      session: createEmptySessionState({ id: "s-w", workingDir: REPO }), reason: "reply", stepCount: 1,
    })),
    createEphemeralSession: (meta) => {
      minted += 1;
      return createEmptySessionState({ id: `${FUSION_WORKER_ID_PREFIX}${minted}`, workingDir: REPO, metadata: { fusionWorker: { ...meta } } });
    },
    approvals: { setSessionPolicy: () => {}, clearSessionPolicy: () => {}, fanoutScopes: new FanoutScopeRegistry() },
    approvalRequired: false,
    emitEvent: () => {},
    workingDir: REPO,
    slotManager: { poolSize: () => 4 },
    resolveRunMode: () => fusionMode(),
    workerSupportsSlotAffinity: () => true,
    warmWorkerBackend: async () => {},
    outputCharCap: 4000,
    logger,
    ...over,
  };
}

const ctx = (project?: ProjectState): ToolContext => ({
  workingDir: REPO, sessionId: "s-parent", stepIndex: 0, signal: new AbortController().signal,
  ...(project === undefined ? {} : { project }),
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
const row = (taskId: string, milestoneId: string, worker = "local-llama:small"): AssignmentRow => ({
  taskId, title: taskId, milestoneId, worker, reviewer: null, reason: "preset", basis: "preset", samples: 0, estCostUsd: null, estMs: null,
});
const brief: ProjectUpdate = { kind: "brief", brief: { what: "A game", users: "Kids", how: "HTML", successCriteria: ["Runs offline"] }, draftedAfterUntrusted: false };
const plan: ProjectUpdate = {
  kind: "plan",
  milestones: [{ id: "m1", title: "Base", kind: "base" }, { id: "m2", title: "UI", kind: "ui" }],
  rows: [row("board", "m1"), row("score", "m2")],
  detail: "compact",
};
const running = () => approve(up(approve(up(undefined, brief)), plan));
const task = (id: string) => ({ id, title: id, instructions: `Write /repo/src/${id}.js` });

describe("fusion.delegate with a project (issue #39)", () => {
  it("refuses before the plan is approved, with guidance, and runs no worker", async () => {
    const d = deps();
    const result = await buildFusionDelegateTool(d).run({ tasks: [task("board")] }, ctx(up(undefined, brief)));
    expect(result.status).toBe("error");
    expect(result.details).toMatchObject({ reason: "project-gate", gate: "awaiting-person" });
    expect(result.summary).toMatch(/approv/);
    expect(d.runTurn).not.toHaveBeenCalled();
  });

  it("refuses a task of a milestone that is not approved, and a cancelled project", async () => {
    const d = deps();
    const later = await buildFusionDelegateTool(d).run({ tasks: [task("score")] }, ctx(running()));
    expect(later.details).toMatchObject({ reason: "project-gate", gate: "milestone-not-approved" });
    const p = up(undefined, brief);
    const cancelled = applyProjectDecision(p, { gate: p.gate, version: 1, verdict: "cancel" }, { now: NOW });
    if (!cancelled.ok) throw new Error("x");
    const refused = await buildFusionDelegateTool(d).run({ tasks: [task("board")] }, ctx(cancelled.project));
    expect(refused.details).toMatchObject({ reason: "project-gate", gate: "cancelled" });
    expect(d.runTurn).not.toHaveBeenCalled();
  });

  it("the approved plan stands for the fan-out prompt and the run is recorded on the milestone", async () => {
    const { gate, prompts } = gateAnswering();
    const d = deps({ approvalRequired: true, approvals: gate });
    const result = await buildFusionDelegateTool(d).run({ tasks: [task("board")] }, ctx(running()));
    expect(prompts).toEqual([]);
    expect(d.runTurn).toHaveBeenCalled();
    expect(result.details.projectUpdate).toMatchObject({ kind: "milestone_run", id: "m1" });
    const runId = (result.details.projectUpdate as { runId: string }).runId;
    // The fold marks it in progress.
    const after = applyProjectUpdate(running(), result.details.projectUpdate as ProjectUpdate, NOW);
    expect(after).toMatchObject({ ok: true, project: { milestones: [{ state: "in_progress", runIds: [runId] }, { state: "planned" }] } });
  });

  it("every worker's brief carries the approved brief and its success criteria", async () => {
    const d = deps();
    await buildFusionDelegateTool(d).run({ tasks: [task("board")] }, ctx(running()));
    const message = (d.runTurn as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    expect(message).toContain("PROJECT: A game");
    expect(message).toContain("- Runs offline");
  });

  it("a task outside the plan, another worker or a write outside the folder still asks", async () => {
    for (const tasks of [
      [task("board"), task("extra")],
      [{ ...task("board"), role: "review" }],
      [{ id: "board", title: "board", instructions: "Write /elsewhere/x.js" }],
    ]) {
      const { gate, prompts } = gateAnswering();
      const d = deps({
        approvalRequired: true,
        approvals: gate,
        resolveRunMode: () => ({
          ...fusionMode(),
          roles: { byRole: { review: { providerId: "cloud-r", model: "reviewer", local: false } }, mixLocalModels: false, localLegProviderIds: [] },
        }),
      });
      await buildFusionDelegateTool(d).run({ tasks }, ctx(running()));
      expect(prompts.map((p) => p.tool), JSON.stringify(tasks)).toEqual(["fusion.delegate"]);
    }
  });

  it("without a project nothing changes: the fan-out asks and records no project update", async () => {
    const { gate, prompts } = gateAnswering();
    const d = deps({ approvalRequired: true, approvals: gate });
    const result = await buildFusionDelegateTool(d).run({ tasks: [task("board")] }, ctx());
    expect(prompts).toHaveLength(1);
    expect(result.details.projectUpdate).toBeUndefined();
  });
});
