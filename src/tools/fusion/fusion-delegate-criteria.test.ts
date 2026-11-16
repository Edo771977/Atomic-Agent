import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const logger = new StructuredLogger({ level: "error", sinks: [] });
const NOW = 1_700_000_000_000;
const ACCEPT = JSON.stringify({ decision: "accept", issues: [] });

function mode(): ResolvedRunMode {
  return {
    stored: "fusion", effective: "fusion", orchestratorProviderId: "cloud", orchestratorModel: "big",
    workerProviderId: "local", workerModel: "small", workers: 1, workersPinned: true, workerMaxSteps: 7,
    workerTimeoutMs: 60_000, primaryProviderId: "cloud", degraded: null, judge: { providerId: "cloud", model: "model-a" },
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

function setup(over: Partial<FusionDelegateDeps> = {}) {
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
    ...over,
  };
  const run = () =>
    buildFusionDelegateTool(d).run(
      {
        tasks: [{ id: "t", title: "t", instructions: "draw the board in index.html", files: ["index.html"] }],
        contract: { checks: [{ task: "t", criteria: ["board-looks-right"], judge: "vision", kind: "page", path: "index.html", screenshot: {} }] },
      },
      { workingDir: dir, sessionId: "s-p", stepIndex: 0, signal: new AbortController().signal, project: project() },
    );
  return { dir, run };
}

type Row = { status: string; notes?: string[]; judge?: { criteria?: Array<{ id: string; state: string }> } };

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

  it("does not close a task whose visual criterion has no vision judge: it goes to the director", async () => {
    const { dir, run } = setup();
    const result = await run();
    const row = (result.details.tasks as Row[])[0]!;
    expect(row.status).toBe("needs_orchestrator");
    expect(row.notes?.join(" ")).toContain("[board-looks-right]");
    expect(row.judge?.criteria).toEqual([expect.objectContaining({ id: "board-looks-right", state: "unverified" })]);
    rmSync(dir, { recursive: true, force: true });
  });
});
