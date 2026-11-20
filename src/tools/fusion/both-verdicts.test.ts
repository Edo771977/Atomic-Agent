/**
 * Issue #102 item 3: the plan closes only after an explicit accept for
 * every required task, and a valid open objection keeps the milestone
 * open even with every suite green. Through the real delegate, its run
 * files read by the real project.milestone.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { readMilestoneEvidence } from "./run-criteria.js";
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
const planRow = (taskId: string) => ({ taskId, title: taskId, milestoneId: "m1", worker: "local:small", reviewer: "cli-b:model-r", reason: "preset", basis: "preset" as const, samples: 0, estCostUsd: 0, estMs: 1000 });
const TASKS = {
  program: { id: "program", title: "Program", instructions: "write sales.cjs", files: ["sales.cjs"] },
  tests: { id: "tests", title: "Tests", instructions: "write the tests in sales.test.cjs", files: ["sales.test.cjs"] },
};

describe("both verdicts close the milestone (issue #102)", () => {
  it("green suites with one open objection keep it open; the explicit accept of both closes it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "both-verdicts-"));
    const state = mkdtempSync(join(tmpdir(), "both-verdicts-state-"));
    try {
      const runsDir = join(state, "fusion-runs");
      const runTurn: FusionDelegateDeps["runTurn"] = async (session, message) => {
        if (message.includes("sales.test.cjs")) writeFileSync(join(dir, "sales.test.cjs"), "require('node:test')('sums', () => {});\n");
        else writeFileSync(join(dir, "sales.cjs"), "module.exports = () => 0;\n");
        return { session: createEmptySessionState({ id: session.id, workingDir: dir }), reason: "reply", stepCount: 1 } as RunTurnResult;
      };
      let testsObjection = true;
      const complete: EscalationComplete = async (call) => ({
        content: call.prompt.includes("write the tests in sales.test.cjs") && testsObjection
          ? JSON.stringify({ decision: "needs-changes", issues: [{ item: "a2", severity: "blocker", file: "sales.test.cjs", why: "no case covers blank lines" }] })
          : review("accept"),
      });
      // Every suite is green, both rounds.
      const runChecks: FusionDelegateDeps["runChecks"] = async (specs) => ({ ok: true, results: specs.map(() => ({ ok: true, summary: "node --test: 9 passed" })) });
      const tool = buildFusionDelegateTool(deps(dir, complete, runTurn, { runCheckpoints: new FusionRunStore({ dir: runsDir }), runChecks }));
      const contract = { checks: [
        { task: "program", type: "command", command: "node --test sales.test.cjs" },
        { task: "tests", type: "command", command: "node --test sales.test.cjs" },
      ] };
      let p = fold(undefined, { kind: "brief", brief: { what: "CSV sales", users: "ops", how: "node", successCriteria: ["sums revenue"] }, draftedAfterUntrusted: false });
      p = approve(fold(approve(p), { kind: "plan", milestones: [{ id: "m1", title: "CLI", kind: "base" }], rows: [planRow("program"), planRow("tests")], detail: "compact" }));
      const [, , milestone] = buildProjectTools({
        planContext: () => { throw new Error("unused"); },
        outsideContent: () => false,
        milestoneEvidence: (m, order, current) => readMilestoneEvidence({ runsDir, stateDir: state, runIds: m.runIds, criteriaOrder: order, ...current }),
        correctionBudgetLeft: () => true,
      });
      const report = () => milestone!.run({ id: "m1", state: "done", summary: "both suites green" }, { workingDir: dir, sessionId: "s", stepIndex: 0, project: p } as unknown as ToolContext);
      const delegate = async (tasks: Array<(typeof TASKS)[keyof typeof TASKS]>) => {
        const ids = new Set(tasks.map((t) => t.id));
        const result = await tool.run({ tasks, contract: { checks: contract.checks.filter((c) => ids.has(c.task)) } }, ctx(dir));
        p = fold(p, { kind: "milestone_run", id: "m1", runId: result.details.runId as string });
      };

      await delegate([TASKS.program, TASKS.tests]);
      const open = await report();
      expect(open.status).not.toBe("ok");
      expect(open.summary).toContain("tests");
      expect(open.summary).not.toMatch(/\bprogram\b.*needs-changes/);
      expect(p.milestones[0]!.state).toBe("in_progress");

      // The objection is addressed under the row's own id and the reviewer accepts.
      testsObjection = false;
      await delegate([TASKS.tests]);
      const done = await report();
      expect(done.status).toBe("ok");
      p = fold(p, done.details[PROJECT_UPDATE_DETAIL] as ProjectUpdate);
      expect(approve(p).milestones[0]!.state).toBe("reviewed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(state, { recursive: true, force: true });
    }
  });
});
