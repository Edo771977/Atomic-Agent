import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { receiptHash } from "../../session/receipt-signing.js";
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
  const run = (withProject = true, checks: Array<Record<string, unknown>> = [{ task: "t", criteria: ["board-looks-right"], judge: "vision", kind: "page", path: "index.html", screenshot: {} }]) =>
    buildFusionDelegateTool(d).run(
      {
        tasks: [{ id: "t", title: "t", instructions: "draw the board in index.html", files: ["index.html"] }],
        contract: { checks },
      },
      { workingDir: dir, sessionId: "s-p", stepIndex: 0, signal: new AbortController().signal, ...(withProject ? { project: project() } : {}) },
    );
  return { dir, run, deps: d };
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

  it("keeps the UI fingerprint reproducible from the milestone run directory", async () => {
    const state = mkdtempSync(join(tmpdir(), "fusion-ui-evidence-"));
    const runsDir = join(state, "fusion-runs");
    const { dir, run } = setup({
      runCheckpoints: new FusionRunStore({ dir: runsDir }),
      runChecks: async () => ({ ok: true, results: [{ ok: true, stdoutTail: "detector evidence", impeccableVersion: "4.10.0" }] }),
    });
    try {
      const bin = join(dir, "node_modules", ".bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, process.platform === "win32" ? "impeccable.cmd" : "impeccable"), "", { mode: 0o700 });
      const id = "board-looks-right";
      const result = await run(true, [{ task: "t", criteria: [id], type: "ui", path: "index.html" }]);
      const { runId } = result.details.projectUpdate as { runId: string };
      const { facts } = readMilestoneEvidence({ runsDir, stateDir: state, runIds: [runId], criteriaOrder: [id] });
      const basis = facts[0]?.basis;
      const hash = receiptHash("detector evidence");
      expect(basis).toMatchObject({ kind: "check", checks: [{ kind: "ui", runId, outputHash: hash }] });
      expect(receiptHash(readFileSync(join(runsDir, runId, `ui-${hash}.txt`), "utf8"))).toBe(hash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("a candidate run keeps its facts and shots under a real run id, with no resumable checkpoint (issue #74)", async () => {
    const state = mkdtempSync(join(tmpdir(), "fusion-criteria-state-"));
    const runsDir = join(state, "fusion-runs");
    const store = new FusionRunStore({ dir: runsDir });
    const start = vi.spyOn(store, "start");
    const checkRuns: unknown[] = [];
    const describeImage = vi.fn<VisionDescribe>(async () => ({ text: '[{"criterion":"board-looks-right","met":false,"why":"no squares"}]' }));
    const { dir, run } = setup((d) => ({
      resolveRunMode: () => ({ ...mode(), integration: "candidate" }),
      runCheckpoints: store,
      visionJudge: { sees: () => true, route: () => null, describe: describeImage },
      createEphemeralSession: (meta, workingDir) =>
        createEmptySessionState({ id: `${FUSION_WORKER_ID_PREFIX}${meta.taskId}`, workingDir: workingDir ?? d, metadata: { fusionWorker: { ...meta } } }),
      runTurn: async (session) => {
        writeFileSync(join(session.workingDir, "index.html"), "<title>Chess</title><div id=board></div>");
        return { session, reason: "reply", stepCount: 1 } as RunTurnResult;
      },
      runChecks: async (_specs, ctx) => {
        checkRuns.push(ctx.run);
        return { ok: true, results: [{ ok: true, summary: "verify.run page: ok", screenshots: [{ path: join(d, "t-1.jpg"), bytes: 3, width: 10, height: 10 }] }] };
      },
    }));
    const result = await run();
    const update = result.details.projectUpdate as { kind: string; runId: string };
    expect(update.kind).toBe("milestone_run");
    expect(update.runId).not.toMatch(/^fanout-/);
    expect(FusionRunStore.isValidRunId(update.runId)).toBe(true);
    // Candidate mode stays non-resumable: no checkpoint, no resumable id.
    expect(start).not.toHaveBeenCalled();
    expect(result.details.runId).toBeUndefined();
    expect(store.load(update.runId)).toBeNull();
    // The checks' screenshots go to that run's folder, and its facts too.
    expect(checkRuns).toContainEqual({ runId: update.runId, sessionId: "s-p" });
    const evidence = readMilestoneEvidence({ runsDir, stateDir: state, runIds: [update.runId], criteriaOrder: ["board-looks-right"] });
    expect(evidence.facts[0]).toMatchObject({ id: "board-looks-right", state: "failed" });
    rmSync(dir, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  });

  it("a candidate that is not promoted keeps no passed criterion; a promoted one does (issue #74)", async () => {
    const runFor = async (promote: boolean) => {
      const state = mkdtempSync(join(tmpdir(), "fusion-criteria-state-"));
      const runsDir = join(state, "fusion-runs");
      const describeImage = vi.fn<VisionDescribe>(async () => ({ text: '[{"criterion":"board-looks-right","met":true,"why":"an 8x8 board"}]' }));
      const { dir, run } = setup((d) => ({
        resolveRunMode: () => ({ ...mode(), integration: "candidate" }),
        runCheckpoints: new FusionRunStore({ dir: runsDir }),
        visionJudge: { sees: () => true, route: () => null, describe: describeImage },
        createEphemeralSession: (meta, workingDir) =>
          createEmptySessionState({ id: `${FUSION_WORKER_ID_PREFIX}${meta.taskId}`, workingDir: workingDir ?? d, metadata: { fusionWorker: { ...meta } } }),
        runTurn: async (session) => {
          writeFileSync(join(session.workingDir, "index.html"), "<title>Chess</title><div id=board></div>");
          // The person edits the same file in the folder meanwhile: the candidate is held back.
          if (!promote) writeFileSync(join(d, "index.html"), "the person's own edit");
          return { session, reason: "reply", stepCount: 1 } as RunTurnResult;
        },
        runChecks: async () => ({ ok: true, results: [{ ok: true, summary: "verify.run page: ok", screenshots: [{ path: join(d, "t-1.jpg"), bytes: 3, width: 10, height: 10 }] }] }),
      }));
      const result = await run();
      const runId = (result.details.projectUpdate as { runId: string }).runId;
      const evidence = readMilestoneEvidence({ runsDir, stateDir: state, runIds: [runId], criteriaOrder: ["board-looks-right"] });
      const status = (result.details.candidateIntegration as { status: string }).status;
      rmSync(dir, { recursive: true, force: true });
      rmSync(state, { recursive: true, force: true });
      return { evidence, status };
    };
    const rejected = await runFor(false);
    expect(rejected.status).toBe("rejected");
    expect(rejected.evidence.facts[0]).toMatchObject({ id: "board-looks-right", state: "unverified" });
    expect(rejected.evidence.facts[0]!.why).toMatch(/not promoted/);
    const promoted = await runFor(true);
    expect(promoted.status).toBe("promoted");
    expect(promoted.evidence.facts[0]).toMatchObject({ id: "board-looks-right", state: "passed" });
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

  it("refuses a check naming a criterion the approved brief does not have", async () => {
    const runTurn = vi.fn();
    const { dir, run } = setup({ runTurn });
    const result = await run(true, [{ task: "t", criteria: ["no-such-thing"], kind: "command", cmd: "x" }]);
    expect(result.status).toBe("error");
    expect(result.summary).toContain("no-such-thing");
    expect(runTurn).not.toHaveBeenCalled();
    rmSync(dir, { recursive: true, force: true });
  });

  it("counts the vision call in the judge's cost on the row", async () => {
    const describeImage = vi.fn<VisionDescribe>(async () => ({
      text: '[{"criterion":"board-looks-right","met":true,"why":"ok"}]',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, costUsd: 0.25 },
    }));
    const { dir, run } = setup({ visionJudge: { sees: () => true, route: () => null, describe: describeImage } });
    const result = await run();
    const row = (result.details.tasks as Array<Row & { judge?: { costUsd?: number | null } }>)[0]!;
    expect(row.judge?.costUsd).toBeCloseTo(0.25);
    rmSync(dir, { recursive: true, force: true });
  });

  it("asks no vision judge when the task's facts are already red", async () => {
    const describeImage = vi.fn<VisionDescribe>(async () => ({ text: '[{"criterion":"board-looks-right","met":true,"why":"ok"}]' }));
    const { dir, run } = setup((d) => ({
      visionJudge: { sees: () => true, route: () => null, describe: describeImage },
      runChecks: async (specs: readonly Record<string, unknown>[]) => ({
        ok: false,
        results: specs.map((spec) => spec.kind === "page"
          ? { ok: true, summary: "ok", screenshots: [{ path: join(d, "t-1.jpg"), bytes: 3, width: 10, height: 10 }] }
          : { ok: false, summary: "verify.run command: exit 1", error: "exit 1" }),
      }),
    }));
    const result = await run(true, [
      { task: "t", kind: "command", cmd: "node", args: ["-e", "process.exit(1)"] },
      { task: "t", criteria: ["board-looks-right"], judge: "vision", kind: "page", path: "index.html", screenshot: {} },
    ]);
    expect(describeImage).not.toHaveBeenCalled();
    expect((result.details.tasks as Row[])[0]!.status).not.toBe("ok");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("a resumed run tags its facts with the criteria its checks were written for (issue #87)", () => {
  const V1 = { id: "a", text: "Works offline" };
  const V2 = { id: "a", text: "Supports live collaboration" };
  const projectWith = (text: { id: string; text: string }, before?: ProjectState): ProjectState => {
    const briefed = approve(up(before, { kind: "brief", brief: { what: "Notes", users: "Teams", how: "Web", successCriteria: [text] }, draftedAfterUntrusted: false }));
    return approve(up(briefed, {
      kind: "plan",
      milestones: [{ id: "m1", title: "Base", kind: "base" }],
      rows: ["t", "u"].map((taskId) => ({ taskId, title: taskId, milestoneId: "m1", worker: "local:small", reviewer: null, reason: "preset", basis: "preset" as const, samples: 0, estCostUsd: null, estMs: null })),
      detail: "compact",
    }));
  };

  it("a run interrupted under v1 and resumed under v2 writes v1-tagged facts, which read stale", async () => {
    const state = mkdtempSync(join(tmpdir(), "fusion-criteria-resume-"));
    const runsDir = join(state, "fusion-runs");
    const store = new FusionRunStore({ dir: runsDir });
    const controller = new AbortController();
    let stop = true;
    const d = setup((work) => ({
      runCheckpoints: store,
      runChecks: async () => ({ ok: true, results: [{ ok: true, summary: "offline test: ok" }] }),
      runTurn: async () => {
        // The first fan-out is cut off while its first worker runs: u never starts.
        if (stop) controller.abort();
        return { session: createEmptySessionState({ id: "s-w", workingDir: work }), reason: "reply", stepCount: 1 } as RunTurnResult;
      },
    }));
    const tool = buildFusionDelegateTool(d.deps);
    const args = {
      tasks: [
        { id: "t", title: "t", instructions: "set up the app" },
        { id: "u", title: "u", instructions: "make it work offline" },
      ],
      contract: { checks: [{ task: "u", type: "command", command: "npm test", criteria: ["a"] }] },
    };
    const v1 = projectWith(V1);
    const first = await tool.run(args, { workingDir: d.dir, sessionId: "s-p", stepIndex: 0, signal: controller.signal, project: v1 });
    const runId = first.details.runId as string;
    expect(store.load(runId)?.criteria).toEqual([V1]);
    // Criterion a reworded; brief and plan approved again; the run resumed.
    stop = false;
    const v2 = projectWith(V2, v1);
    const resumed = await tool.run({ resume: runId }, { workingDir: d.dir, sessionId: "s-p", stepIndex: 0, signal: new AbortController().signal, project: v2 });
    expect(resumed.status).not.toBe("error");
    expect((resumed.details.resume as { rerun: string[] }).rerun).toEqual(["u"]);
    const stored = JSON.parse(readFileSync(join(runsDir, runId, "criteria.json"), "utf8")) as { tasks: Array<{ taskId: string; facts: Array<{ id: string; text?: string }> }> };
    expect(stored.tasks.find((t) => t.taskId === "u")!.facts[0]).toMatchObject({ id: "a", state: "passed", text: V1.text });
    const evidence = readMilestoneEvidence({ runsDir, stateDir: state, runIds: [runId], criteriaOrder: ["a"], criteria: [V2], briefApprovals: v2.briefApprovals! });
    expect(evidence.facts).toEqual([expect.objectContaining({ id: "a", state: "unverified" })]);
    rmSync(d.dir, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  });
});

