import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApprovalGate, type ApprovalRequest } from "../../approval/approval-gate.js";
import type { RunTurnResult } from "../../agent/agent-loop.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import type { TeamMember } from "../../llm/run-mode/fusion-team.js";
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
 * The reviewer the person picks per plan row at the plan gate is the one
 * that reviews the task at run time (issue #74): "no review" reviews
 * nothing, a stronger pick replaces the team's; a reviewer that cannot
 * run any more makes the fan-out ask, and says so.
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

const mode = (): ResolvedRunMode => ({
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
const row = (reviewer: string | null): AssignmentRow => ({
  taskId: "t", title: "T", milestoneId: "m1", worker: "local:small", reviewer, reason: "preset", basis: "preset", samples: 0, estCostUsd: null, estMs: null,
});
/** An approved project whose one row has `reviewer`; `byPerson`: the person picked it at the gate. */
const project = (reviewer: string | null, byPerson: boolean): ProjectState => {
  const brief: ProjectUpdate = { kind: "brief", brief: { what: "A game", users: "Kids", how: "HTML", successCriteria: ["Runs"] }, draftedAfterUntrusted: false };
  const plan: ProjectUpdate = { kind: "plan", milestones: [{ id: "m1", title: "Base", kind: "base" }], rows: [row(reviewer)], detail: "compact" };
  const p = approve(up(approve(up(undefined, brief)), plan));
  return byPerson ? { ...p, plan: { ...p.plan!, rows: p.plan!.rows.map((r) => ({ ...r, reviewerByPerson: true as const })) } } : p;
};

async function run(p: ProjectState, over: Partial<FusionDelegateDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "plan-reviewer-"));
  const calls: string[] = [];
  const briefs: string[] = [];
  const prompts: ApprovalRequest[] = [];
  const gate: ApprovalGate = new ApprovalGate({
    level: 1,
    emit: (req) => {
      prompts.push(req);
      queueMicrotask(() => gate.resolve({ approvalId: req.approvalId, approved: true }));
    },
  });
  let minted = 0;
  const d: FusionDelegateDeps = {
    runTurn: async (_s: unknown, message: string) => {
      briefs.push(message);
      writeFileSync(join(dir, "a.txt"), "done");
      return { session: createEmptySessionState({ id: "s-w", workingDir: dir }), reason: "reply", stepCount: 1 } as RunTurnResult;
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
    escalationComplete: async (call) => {
      calls.push(`${call.providerId}:${call.model}`);
      return { content: ACCEPT };
    },
    resolveFusionTeam: () => team(),
    ...over,
  };
  const result = await buildFusionDelegateTool(d).run(
    { tasks: [{ id: "t", title: "T", instructions: "write a.txt", files: ["a.txt"] }] },
    { workingDir: dir, sessionId: "s-plan", stepIndex: 0, signal: new AbortController().signal, project: p },
  );
  rmSync(dir, { recursive: true, force: true });
  return { calls, briefs, prompts, result };
}

describe("the plan row's reviewer reviews the task (issue #74)", () => {
  it("the person's stronger pick reviews instead of the team's, and the plan still stands for the prompt", async () => {
    // The team picks cli-b:model-r for the local worker.
    const teamPick = await run(project("cli-b:model-r", false));
    expect(teamPick.calls).toEqual(["cli-b:model-r"]);
    expect(teamPick.prompts).toEqual([]);
    const picked = await run(project("api-a:model-o", true));
    expect(picked.calls).toEqual(["api-a:model-o"]);
    expect(picked.prompts).toEqual([]);
  });

  it("the person's \"no review\" reviews nothing, not even on judgeProvider", async () => {
    const none = await run(project(null, true), { resolveRunMode: () => ({ ...mode(), judge: { providerId: "api-a", model: "judge" } }) });
    expect(none.calls).toEqual([]);
    expect(none.briefs[0]).not.toContain("ACCEPTANCE CHECKLIST");
    expect(none.prompts).toEqual([]);
  });

  it("the person's pick reviews even with team.review \"off\"", async () => {
    const picked = await run(project("api-a:model-o", true), { resolveFusionTeam: () => team({}, { review: "off" }) });
    expect(picked.calls).toEqual(["api-a:model-o"]);
    expect(picked.prompts).toEqual([]);
  });

  it("without a person's pick the chat's reviewer stays the default; a reviewer other than the row's asks", async () => {
    const chat = (): TeamMember => ({ providerId: "api-a", model: "model-o", ref: "api-a:model-o" });
    const drafted = await run(project("cli-b:model-r", false), { currentReviewer: chat });
    expect(drafted.calls).toEqual(["api-a:model-o"]);
    expect(drafted.prompts.map((q) => q.tool)).toEqual(["fusion.delegate"]);
    // The person's pick wins over the chat's.
    const person = await run(project("cli-b:model-r", true), { currentReviewer: chat });
    expect(person.calls).toEqual(["cli-b:model-r"]);
    expect(person.prompts).toEqual([]);
  });

  it("the person's reviewer no longer usable: the fan-out asks and says so", async () => {
    const gone = await run(project("api-a:model-o", true), { resolveFusionTeam: () => team({ reachable: (m) => m.ref !== "api-a:model-o" }) });
    expect(gone.prompts).toHaveLength(1);
    expect(gone.prompts[0]!.reason).toMatch(/api-a:model-o.*no longer usable/);
    expect(gone.calls).toEqual(["cli-b:model-r"]);
    const rows = gone.result.details.tasks as Array<{ notes?: string[] }>;
    expect(rows[0]!.notes).toContain("plan reviewer api-a:model-o is no longer usable here; cli-b:model-r reviews it instead");
  });
});
