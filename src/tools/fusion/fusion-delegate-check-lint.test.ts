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
import type { ContractCheckRunner } from "./contract-checks.js";
import { buildFusionDelegateTool, type FusionDelegateDeps } from "./fusion-delegate.js";

/**
 * Issue #110 at the `fusion.delegate` seam: a contract whose checks
 * cannot fail is refused before any worker or check runs, and the weak
 * ones are named where the director and the person read them.
 */

const logger = new StructuredLogger({ level: "error", sinks: [] });
const NOW = 1_700_000_000_000;

function mode(): ResolvedRunMode {
  return {
    stored: "fusion", effective: "fusion", orchestratorProviderId: "cloud", orchestratorModel: "big",
    workerProviderId: "local", workerModel: "small", workers: 1, workersPinned: true, workerMaxSteps: 7,
    workerTimeoutMs: 60_000, primaryProviderId: "cloud", degraded: null,
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
/** An approved CSV project: one criterion, one task. */
const project = (): ProjectState =>
  approve(up(approve(up(undefined, {
    kind: "brief",
    brief: { what: "A CSV summarizer", users: "Shops", how: "Node", successCriteria: [{ id: "c1", text: "invalid rows are refused" }] },
    draftedAfterUntrusted: false,
  })), {
    kind: "plan",
    milestones: [{ id: "m1", title: "Summarizer", kind: "logic" }],
    rows: [{ taskId: "t", title: "t", milestoneId: "m1", worker: "local:small", reviewer: null, reason: "preset", basis: "preset", samples: 0, estCostUsd: null, estMs: null }],
    detail: "compact",
  }));

function setup(over: Partial<FusionDelegateDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fusion-check-lint-"));
  let minted = 0;
  const runTurn = vi.fn(async () => {
    writeFileSync(join(dir, "sales.cjs"), "module.exports = 1;\n");
    return { session: createEmptySessionState({ id: "s-w", workingDir: dir }), reason: "reply", stepCount: 1 } as RunTurnResult;
  });
  const runChecks = vi.fn<ContractCheckRunner>(async (specs) => ({ ok: true, results: specs.map(() => ({ ok: true, summary: "verify.run command: ok" })) }));
  const d: FusionDelegateDeps = {
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
    resolveRunMode: () => mode(),
    workerSupportsSlotAffinity: () => false,
    warmWorkerBackend: async () => {},
    outputCharCap: 8000,
    logger,
    runChecks,
    ...over,
  };
  const run = (checks: Array<Record<string, unknown>>, withProject = false) =>
    buildFusionDelegateTool(d).run(
      { tasks: [{ id: "t", title: "t", instructions: "write sales.cjs", files: ["sales.cjs"] }], contract: { checks } },
      { workingDir: dir, sessionId: "s-p", stepIndex: 0, signal: new AbortController().signal, ...(withProject ? { project: project() } : {}) },
    );
  return { dir, run, runTurn, runChecks, deps: d, done: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("fusion.delegate lints its contract checks (issue #110)", () => {
  it("refuses `echo ok` before any worker or check runs: the lint executes nothing", async () => {
    const t = setup();
    const result = await t.run([{ task: "t", kind: "command", cmd: "echo ok", checks: ['stdout contains "ok"'] }]);
    expect(result.status).toBe("error");
    expect(result.summary).toContain("contract.checks[0] cannot fail");
    expect(t.runTurn).not.toHaveBeenCalled();
    expect(t.runChecks).not.toHaveBeenCalled();
    t.done();
  });

  it("names a `passed` expectation on a test command on the result's contract line and in its details", async () => {
    const t = setup();
    const result = await t.run([{ task: "t", kind: "command", cmd: "node", args: ["--test"], checks: ['stdout contains "passed"'] }]);
    expect(result.status).toBe("ok");
    const warnings = (result.details.contract as { warnings?: string[] }).warnings ?? [];
    expect(warnings).toEqual([expect.stringMatching(/^check lint \(warning\): contract\.checks\[0\] `stdout contains "passed"` also accepts failure output such as "0 passed"/)]);
    expect(result.summary).toContain("check lint (warning): contract.checks[0]");
    t.done();
  });

  it("puts the warning on the fan-out's approval line, before anything runs", async () => {
    const reasons: string[] = [];
    const t = setup({
      approvalRequired: true,
      approvals: {
        setSessionPolicy: () => {}, clearSessionPolicy: () => {}, fanoutScopes: new FanoutScopeRegistry(),
        request: async (req: { category: string; reason: string }) => {
          if (req.category === "fusion_fanout") reasons.push(req.reason);
          return { approved: true };
        },
      } as unknown as FusionDelegateDeps["approvals"],
    });
    await t.run([{ task: "t", kind: "command", cmd: "node", args: ["--test"], checks: ['stdout contains "passed"'] }]);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/check lint: 1 warning — contract\.checks\[0\] `stdout contains "passed"` also accepts failure output/);
    t.done();
  });

  it("hints at a task check that names no criterion when the approved brief has criteria", async () => {
    const t = setup();
    const result = await t.run([{ task: "t", kind: "command", cmd: "node", args: ["--test"], checks: ["exit 0"] }], true);
    expect(result.status).not.toBe("error");
    const warnings = (result.details.contract as { warnings?: string[] }).warnings ?? [];
    expect(warnings).toContainEqual(expect.stringMatching(/^check lint \(hint\): contract\.checks\[0\] names no success criterion while the approved brief has 1/));
    t.done();
  });

  it("raises nothing for the CSV e2e's own checks", async () => {
    const t = setup();
    const result = await t.run([
      { task: "t", kind: "command", cmd: "node", args: ["--test", "sales.test.cjs"], checks: ["exit 0"] },
      { task: "t", kind: "command", cmd: "node sales.cjs bad-header.csv", checks: ["exit != 0", 'stderr contains "Invalid header"'] },
      { task: "t", kind: "command", cmd: "node", args: ["sales.cjs", "zero.csv"], checks: ["exit 0", 'stdout contains "{\\"X\\":0}"'] },
    ]);
    expect(result.status).toBe("ok");
    expect((result.details.contract as { warnings?: string[] }).warnings).toBeUndefined();
    t.done();
  });
});
