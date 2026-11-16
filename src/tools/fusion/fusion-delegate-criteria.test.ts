import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FanoutScopeRegistry } from "../../approval/fanout-scope.js";
import type { RunTurnResult } from "../../agent/agent-loop.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import { FUSION_WORKER_ID_PREFIX } from "../../session/fusion-worker-session.js";
import {
  applyProjectDecision,
  applyProjectUpdate,
  gateVersion,
  type ProjectState,
  type ProjectUpdate,
} from "../../session/session-project.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import { buildFusionDelegateTool, type FusionDelegateDeps } from "./fusion-delegate.js";
import type { VisionDescribe } from "./vision-judge.js";
import { FusionRunStore } from "./run-checkpoint.js";
import { readMilestoneEvidence } from "./run-criteria.js";

const logger = new StructuredLogger({ level: "error", sinks: [] });
const NOW = 1_700_000_000_000;
const ACCEPT = JSON.stringify({ decision: "accept", issues: [] });

function mode(judge: ResolvedRunMode["judge"] = { providerId: "cloud", model: "model-a" }): ResolvedRunMode {
  return {
    stored: "fusion", effective: "fusion", orchestratorProviderId: "cloud", orchestratorModel: "big",
    workerProviderId: "local", workerModel: "small", workers: 1, workersPinned: true, workerMaxSteps: 7,
    workerTimeoutMs: 60_000, primaryProviderId: "cloud", degraded: null, judge,
  };
}

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
const project = (): ProjectState =>
  approve(up(approve(up(undefined, {
    kind: "brief",
    brief: { what: "A chess game", users: "Players", how: "HTML", successCriteria: [{ id: "board-looks-right", text: "the board looks like a chess board" }] },
    draftedAfterUntrusted: false,
  })), {
    kind: "plan",
    milestones: [{ id: "m1", title: "Board", kind: "ui" }],
    rows: [{ taskId: "t", title: "t", milestoneId: "m1", worker: "local:small", reviewer: null, reason: "preset", basis: "preset", samples: 0, estCostUsd: null, estMs: null }],
    detail: "compact",
  }));

function setup(over: Partial<FusionDelegateDeps> | ((dir: string) => Partial<FusionDelegateDeps>) = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fusion-criteria-"));
  const shot = join(dir, "t-1.jpg");
  writeFileSync(shot, Buffer.from([0xff, 0xd8, 0xff]));
  let minted = 0;
  const d: FusionDelegateDeps = {
    runTurn: async () => {
      writeFileSync(join(dir, "index.html"), "<title>Chess</title><div id=board></div>");
      return { session: createEmptySessionState({ id: "s-w", workingDir: dir }), reason: "reply", stepCount: 1 } as RunTurnResult;
    },
    createEphemeralSession: (meta) => {
      minted += 1;
      return createEmptySessionState({ id: `${FUSION_WORKER_ID_PREFIX}${minted}`, workingDir: dir, metadata: { fusionWorker: { ...meta } } });
    },
    approvals: { setSessionPolicy: () => {}, clearSessionPolicy: () => {}, fanoutScopes: new FanoutScopeRegistry() },
    approvalRequired: false,
    emitEvent: () => {},
    workingDir: dir,
    slotManager: { poolSize: () => 4 },
    resolveRunMode: () => mode(),
    workerSupportsSlotAffinity: () => false,
    warmWorkerBackend: async () => {},
    outputCharCap: 4000,
    logger,
    escalationComplete: async () => ({ content: ACCEPT }),
    runChecks: async () => ({ ok: true, results: [{ ok: true, summary: "verify.run page: ok", screenshots: [{ path: shot, bytes: 3, width: 10, height: 10 }] }] }),
    ...(typeof over === "function" ? over(dir) : over),
  };
  const run = (withProject = true) =>
    buildFusionDelegateTool(d).run(
      {
        tasks: [{ id: "t", title: "t", instructions: "draw the board in index.html", files: ["index.html"] }],
        contract: { checks: [{ task: "t", criteria: ["board-looks-right"], judge: "vision", kind: "page", path: "index.html", screenshot: {} }] },
      },
      { workingDir: dir, sessionId: "s-p", stepIndex: 0, signal: new AbortController().signal, ...(withProject ? { project: project() } : {}) },
    );
  return { dir, run };
}

type Row = { status: string; notes?: string[]; criteria?: Array<{ id: string; state: string }>; judge?: { criteria?: Array<{ id: string; state: string }> } };

describe("fusion.delegate rules a project's visual criteria (issue #40)", () => {
  it("closes a task whose visual criterion the vision judge found met", async () => {
    const describeImage = vi.fn<VisionDescribe>(async () => ({ text: '[{"criterion":"board-looks-right","met":true,"why":"an 8x8 board"}]' }));
    const { dir, run } = setup({ visionJudge: { sees: () => true, route: () => null, describe: describeImage } });
    const result = await run();
    const row = (result.details.tasks as Row[])[0]!;
    expect(describeImage).toHaveBeenCalledOnce();
    expect(describeImage.mock.calls[0]![0]).toMatchObject({ providerId: "cloud", model: "model-a" });
    expect(row.status).toBe("ok");
    expect(row.judge?.criteria).toEqual([expect.objectContaining({ id: "board-looks-right", state: "passed" })]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("records the task's criteria, game and screenshot counts in the outcome log", async () => {
    const append = vi.fn();
    const describeImage = vi.fn<VisionDescribe>(async () => ({ text: '[{"criterion":"board-looks-right","met":true,"why":"ok"}]' }));
    const { dir, run } = setup((d) => ({
      outcomeLog: { append } as unknown as NonNullable<FusionDelegateDeps["outcomeLog"]>,
      visionJudge: { sees: () => true, route: () => null, describe: describeImage },
      runChecks: async () => ({ ok: true, results: [{ ok: true, screenshots: [{ path: join(d, "t-1.jpg"), bytes: 3, width: 10, height: 10 }], games: { n: 3, played: 3, finished: 3, errors: 1, medianMs: 40, medianMoves: 9, winners: { X: 2, O: 1 }, runs: [] } }] }),
    }));
    await run();
    const records = append.mock.calls.flatMap((c) => c[0] as Array<Record<string, unknown>>);
    expect(records.find((r) => r.kind === undefined || r.kind === "task")).toMatchObject({ criteria: { passed: 1, failed: 0, unverified: 0 }, games: { n: 3, errors: 1, medianMs: 40 }, shots: 1 });
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the run's criteria facts with the run, for the milestone report", async () => {
    const state = mkdtempSync(join(tmpdir(), "fusion-criteria-state-"));
    const runsDir = join(state, "fusion-runs");
    const describeImage = vi.fn<VisionDescribe>(async () => ({ text: '[{"criterion":"board-looks-right","met":false,"why":"no squares"}]' }));
    const { dir, run } = setup({ runCheckpoints: new FusionRunStore({ dir: runsDir }), visionJudge: { sees: () => true, route: () => null, describe: describeImage } });
    const result = await run();
    const runId = result.details.runId as string;
    expect(JSON.parse(readFileSync(join(runsDir, runId, "criteria.json"), "utf8")).tasks[0]).toMatchObject({ taskId: "t", facts: [{ id: "board-looks-right", state: "failed" }] });
    const evidence = readMilestoneEvidence({ runsDir, stateDir: state, runIds: [runId], criteriaOrder: ["board-looks-right"] });
    expect(evidence.facts[0]).toMatchObject({ id: "board-looks-right", state: "failed" });
    rmSync(dir, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  });

  it("does not close a task whose visual criterion has no vision judge: it goes to the director", async () => {
    const { dir, run } = setup();
    const result = await run();
    const row = (result.details.tasks as Row[])[0]!;
    expect(row.status).toBe("needs_orchestrator");
    expect(row.notes?.join(" ")).toContain("[board-looks-right]");
    expect(row.judge?.criteria).toEqual([expect.objectContaining({ id: "board-looks-right", state: "unverified" })]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not close a task whose green visual check names a criterion when no judge runs", async () => {
    const state = mkdtempSync(join(tmpdir(), "fusion-criteria-state-"));
    const runsDir = join(state, "fusion-runs");
    const { dir, run } = setup({ resolveRunMode: () => mode(null), runCheckpoints: new FusionRunStore({ dir: runsDir }) });
    const result = await run();
    const row = (result.details.tasks as Row[])[0]!;
    expect(row.status).toBe("needs_orchestrator");
    expect(row.notes?.join(" ")).toContain("[board-looks-right]");
    expect(row.notes?.join(" ")).toContain("The director decides");
    expect(row.criteria).toEqual([expect.objectContaining({ id: "board-looks-right", state: "unverified" })]);
    const runId = result.details.runId as string;
    expect(JSON.parse(readFileSync(join(runsDir, runId, "criteria.json"), "utf8")).tasks[0]).toMatchObject({ taskId: "t", facts: [{ id: "board-looks-right", state: "unverified" }] });
    rmSync(dir, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  });

  it("keeps facts by criterion id without an approved brief", async () => {
    const { dir, run } = setup();
    const result = await run(false);
    const row = (result.details.tasks as Row[])[0]!;
    expect(row.status).toBe("needs_orchestrator");
    expect(row.criteria).toEqual([expect.objectContaining({ id: "board-looks-right", state: "unverified" })]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the checks' criteria facts when the budget stops the judge", async () => {
    let spent = 0;
    const { dir, run } = setup((d) => ({
      resolveRunMode: () => ({ ...mode(), turnBudgetUsd: 1 }),
      orchestratorTurnSpendUsd: () => spent,
      runChecks: async () => {
        spent = 5;
        return { ok: true, results: [{ ok: true, screenshots: [{ path: join(d, "t-1.jpg"), bytes: 3, width: 10, height: 10 }] }] };
      },
    }));
    const result = await run();
    const row = (result.details.tasks as Row[])[0]!;
    expect(row.status).not.toBe("ok");
    expect(row.criteria).toEqual([expect.objectContaining({ id: "board-looks-right", state: "unverified" })]);
    rmSync(dir, { recursive: true, force: true });
  });
});
