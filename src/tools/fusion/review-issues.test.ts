/**
 * Issue #100 review: the needs-changes issues a run keeps for a targeted
 * fix are only blocker issues that name a file or an item, with their
 * severity; a fact failure whose check did not actually run is not one.
 * Through the real delegate, not hand-written run files.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FanoutScopeRegistry } from "../../approval/fanout-scope.js";
import type { RunTurnResult } from "../../agent/agent-loop.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import { FUSION_WORKER_ID_PREFIX } from "../../session/fusion-worker-session.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import type { ToolContext } from "../tool-registry.js";
import type { EscalationComplete } from "./escalation.js";
import { buildFusionDelegateTool, type FusionDelegateDeps } from "./fusion-delegate.js";
import { FusionRunStore } from "./run-checkpoint.js";
import { readMilestoneEvidence, readRunCriteria } from "./run-criteria.js";
import { buildProjectTools, PROJECT_UPDATE_DETAIL } from "./project-tools.js";
import { applyProjectDecision, applyProjectUpdate, gateVersion, type ProjectState, type ProjectUpdate } from "../../session/session-project.js";
import type { FusionTeamContext } from "./team-routing.js";

const logger = new StructuredLogger({ level: "error", sinks: [] });
const mode = (): ResolvedRunMode => ({
  stored: "fusion", effective: "fusion", orchestratorProviderId: "cloud", orchestratorModel: "big",
  workerProviderId: "local", workerModel: "small", workers: 1, workersPinned: true, workerMaxSteps: 7,
  workerTimeoutMs: 60_000, primaryProviderId: "cloud", degraded: null, judge: { providerId: "cloud", model: "judge-model" },
});
const families: Record<string, "anthropic" | "openai" | "local"> = { "api-a": "anthropic", "cli-b": "openai", local: "local" };
const team: FusionTeamContext = {
  team: { directors: ["api-a:model-a"], workers: ["local:small"], reviewers: ["cli-b:model-r"] },
  fusion: { workerProvider: "local" },
  familyOf: (m) => families[m.providerId] ?? "other",
  reachable: () => true,
  pinsModel: (id) => id !== "local",
};
const review = (decision: "accept" | "needs-changes", why?: string): string =>
  JSON.stringify({ decision, issues: why === undefined ? [] : [{ item: "a3", severity: "blocker", file: "sales.cjs", why }] });

function deps(dir: string, complete: EscalationComplete, runTurn: FusionDelegateDeps["runTurn"], over: Partial<FusionDelegateDeps> = {}): FusionDelegateDeps {
  let minted = 0;
  return {
    runTurn,
    createEphemeralSession: (meta) => {
      minted += 1;
      return createEmptySessionState({ id: `${FUSION_WORKER_ID_PREFIX}${minted}`, workingDir: dir, metadata: { fusionWorker: { ...meta } } });
    },
    approvals: { setSessionPolicy: () => {}, clearSessionPolicy: () => {}, fanoutScopes: new FanoutScopeRegistry() },
    approvalRequired: false,
    emitEvent: () => {},
    workingDir: dir,
    slotManager: { poolSize: () => 4 },
    resolveRunMode: mode,
    resolveFusionTeam: () => team,
    workerSupportsSlotAffinity: () => false,
    warmWorkerBackend: async () => {},
    outputCharCap: 4000,
    logger,
    escalationComplete: complete,
    runChecks: async (specs) => ({ ok: true, results: specs.map(() => ({ ok: true, summary: "node --test: 6 passed" })) }),
    ...over,
  } as FusionDelegateDeps;
}
const ctx = (dir: string): ToolContext => ({ workingDir: dir, sessionId: "s-p", stepIndex: 0, signal: new AbortController().signal });

async function delegateOnce(
  answer: string,
  checks: { ok: boolean; summary: string } | undefined,
  records: Array<Record<string, unknown>> = [],
  after?: (run: { state: string; runsDir: string; runId: string }) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), "review-issues-"));
  const state = mkdtempSync(join(tmpdir(), "review-issues-state-"));
  try {
    const runsDir = join(state, "fusion-runs");
    const runTurn: FusionDelegateDeps["runTurn"] = async (session) => {
      writeFileSync(join(dir, "sales.cjs"), "module.exports = () => 0;\n");
      return { session: createEmptySessionState({ id: session.id, workingDir: dir }), reason: "reply", stepCount: 1 } as RunTurnResult;
    };
    const over: Partial<FusionDelegateDeps> = {
      runCheckpoints: new FusionRunStore({ dir: runsDir }),
      outcomeLog: { append: (rows) => { records.push(...(rows as unknown as Array<Record<string, unknown>>)); } },
    };
    if (checks !== undefined) over.runChecks = async (specs) => ({ ok: checks.ok, results: specs.map(() => ({ ...checks })) });
    const d = deps(dir, async () => ({ content: answer }), runTurn, over);
    const result = await buildFusionDelegateTool(d).run({
      tasks: [{ id: "program", title: "Program", instructions: "write sales.cjs", files: ["sales.cjs"] }],
      ...(checks === undefined ? {} : { contract: { checks: [{ task: "program", type: "command", command: "node --test sales.test.cjs" }] } }),
    }, ctx(dir));
    const runId = result.details.runId as string;
    await after?.({ state, runsDir, runId });
    const stored = JSON.parse(readFileSync(join(runsDir, runId, "criteria.json"), "utf8")) as { reviews: Array<{ verdict: string; issues?: unknown[]; reviewer?: Record<string, unknown> }> };
    return Object.assign(stored, { read: readRunCriteria(runsDir, runId) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
}
const needsChanges = (issues: Array<{ item: string | null; severity: string; file: string | null; why: string }>) => JSON.stringify({ decision: "needs-changes", issues });

describe("the issues a needs-changes keeps for a targeted fix (issue #100 review)", () => {
  it("keeps a blocker that names its file, with its severity; drops a major and a blocker naming nothing", async () => {
    const stored = await delegateOnce(needsChanges([
      { item: "a2", severity: "blocker", file: "sales.cjs", why: "blank lines are no longer skipped" },
      { item: null, severity: "blocker", file: null, why: "feels off" },
      { item: "a2", severity: "major", file: "sales.cjs", why: "could be faster" },
    ]), undefined);
    expect(stored.reviews[0]).toMatchObject({ verdict: "needs-changes" });
    expect(stored.reviews[0]!.issues).toEqual([{ severity: "blocker", text: "sales.cjs: blank lines are no longer skipped" }]);
  });

  it("a fact failure whose check did not actually run (a missing binary) is not a concrete blocker", async () => {
    const stored = await delegateOnce(review("accept"), { ok: false, summary: "verify.run command: not run: node: command not found (ENOENT)" });
    expect(stored.reviews[0]!.verdict).toBe("needs-changes");
    expect(stored.reviews[0]!.issues ?? []).toEqual([]);
  });

  it("a fact failure of a check that ran and failed is one", async () => {
    const stored = await delegateOnce(review("accept"), { ok: false, summary: "verify.run command: FAILED (exit 1): 1 failed" });
    expect(stored.reviews[0]!.issues).toEqual([{ severity: "blocker", text: expect.stringContaining("FAILED (exit 1)") }]);
  });
});

describe("a verdict the facts decided keeps its source (issue #100 review)", () => {
  it("in the outcome record and the run file, and the run file's reader keeps the reviewer", async () => {
    const records: Array<Record<string, unknown>> = [];
    const stored = await delegateOnce(review("accept"), { ok: false, summary: "verify.run command: FAILED (exit 1): 1 failed" }, records);
    expect(stored.reviews[0]!.reviewer).toMatchObject({ source: "facts" });
    expect(stored.read.reviews[0]!.reviewer).toMatchObject({ source: "facts" });
    const task = records.find((r) => r.type === "task") as { review?: Record<string, unknown> };
    expect(task.review).toMatchObject({ decision: "needs-changes", reviewerSource: "facts" });
  });

  it("a reviewer's own verdict has no source, and the reader keeps who it was", async () => {
    const records: Array<Record<string, unknown>> = [];
    const stored = await delegateOnce(review("accept"), undefined, records);
    expect(stored.read.reviews[0]!.reviewer).toEqual({ provider: "cli-b" });
    const task = records.find((r) => r.type === "task") as { review?: Record<string, unknown> };
    expect(task.review!.reviewerSource).toBeUndefined();
  });
});

/** The real delegate's run file, read by the real project.milestone: is a failed report held for correction? */
async function failedAfter(answer: string, checks?: { ok: boolean; summary: string }) {
  let report: Awaited<ReturnType<NonNullable<ReturnType<typeof buildProjectTools>[2]>["run"]>> | undefined;
  await delegateOnce(answer, checks, [], async ({ state, runsDir, runId }) => {
    const fold = (p: ProjectState | undefined, u: ProjectUpdate): ProjectState => {
      const r = applyProjectUpdate(p, u, Date.now());
      if (!r.ok) throw new Error(r.error.message);
      return r.project;
    };
    const approve = (p: ProjectState): ProjectState => {
      const r = applyProjectDecision(p, { gate: p.gate, version: gateVersion(p)!, verdict: "approve" }, { now: Date.now() });
      if (!r.ok) throw new Error(r.error.message);
      return r.project;
    };
    let p = fold(undefined, { kind: "brief", brief: { what: "CSV sales", users: "ops", how: "node", successCriteria: ["sums revenue"] }, draftedAfterUntrusted: false });
    p = approve(fold(approve(p), { kind: "plan", milestones: [{ id: "m1", title: "CLI", kind: "base" }], detail: "compact",
      rows: [{ taskId: "program", title: "Program", milestoneId: "m1", worker: "local:small", reviewer: "cli-b:model-r", reason: "preset", basis: "preset", samples: 0, estCostUsd: 0, estMs: 1000 }] }));
    p = fold(p, { kind: "milestone_run", id: "m1", runId });
    const [, , tool] = buildProjectTools({
      planContext: () => { throw new Error("unused"); },
      outsideContent: () => false,
      milestoneEvidence: (milestone, order, current) => readMilestoneEvidence({ runsDir, stateDir: state, runIds: milestone.runIds, criteriaOrder: order, ...current }),
      correctionBudgetLeft: () => true,
    });
    report = await tool!.run({ id: "m1", state: "failed", summary: "a defect remains" }, { workingDir: "/tmp", sessionId: "s", stepIndex: 0, project: p } as unknown as ToolContext);
  });
  return report!;
}
const held = (r: Awaited<ReturnType<typeof failedAfter>>) => (r.details[PROJECT_UPDATE_DETAIL] as { holdForCorrection?: true } | undefined)?.holdForCorrection === true;

describe("delegate to project.milestone: which needs-changes hold a failed report (issue #100 review)", () => {
  it("a reviewer's blocker naming its file holds it, quoting the blocker", async () => {
    const r = await failedAfter(review("needs-changes", "blank lines are no longer skipped"));
    expect(held(r)).toBe(true);
    expect(r.summary).toContain("program: sales.cjs: blank lines are no longer skipped");
  });

  it("a major alone does not", async () => {
    const r = await failedAfter(needsChanges([{ item: "a2", severity: "major", file: "sales.cjs", why: "could be faster" }]));
    expect(r.status).toBe("ok");
    expect(held(r)).toBe(false);
  });

  it("a check that never ran (a missing binary) does not", async () => {
    const r = await failedAfter(review("accept"), { ok: false, summary: "verify.run command: not run: node: command not found (ENOENT)" });
    expect(held(r)).toBe(false);
  });

  it("a check that ran and failed does", async () => {
    const r = await failedAfter(review("accept"), { ok: false, summary: "verify.run command: FAILED (exit 1): 1 failed" });
    expect(held(r)).toBe(true);
  });
});
