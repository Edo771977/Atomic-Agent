/**
 * Issue #95 item 3: the reviewer sees which attempt changed each file and
 * which version was tested, across review passes; a task that ends with no
 * review verdict is listed, in the fan-out result and the milestone report.
 */
import { createHash } from "node:crypto";
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
import { buildProjectTools } from "./project-tools.js";
import { FusionRunStore } from "./run-checkpoint.js";
import { readMilestoneEvidence } from "./run-criteria.js";
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

const OLD = "total[sku] += qty * price;";
const NEW = "total[sku] = (total[sku] ?? 0) + qty * price;";
const parsedEdit = { type: "llm_event", event: { type: "tool_call_parsed", call: { tool: "os.fs.edit", args: { path: "sales.cjs", oldString: OLD, newString: NEW } }, batchIndex: 0, batchSize: 1 } } as never;
const executedEdit = (ok: boolean) => ({
  type: "llm_event",
  event: {
    type: "tool_call_executed",
    result: { tool: "os.fs.edit", status: ok ? "ok" : "error", summary: ok ? "edited" : "os.fs.edit: `oldString` was not found in the target file.", details: {}, truncated: false },
    batchIndex: 0, batchSize: 1,
  },
}) as never;

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

describe("reviewer evidence across attempts (issue #95)", () => {
  it("a retry that finds its edit already present: the reviewer reads attempt 1 as the change and the tested version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "attempt-evidence-"));
    try {
      writeFileSync(join(dir, "sales.cjs"), `${OLD}\n`);
      let turns = 0;
      const prompts: string[] = [];
      const runTurn: FusionDelegateDeps["runTurn"] = async (session, _m, options) => {
        turns += 1;
        options.eventHook?.(parsedEdit);
        if (turns === 1) writeFileSync(join(dir, "sales.cjs"), `${NEW}\n`);
        // The retry finds the old text gone: the edit is already there.
        options.eventHook?.(executedEdit(turns === 1));
        return { session: createEmptySessionState({ id: session.id, workingDir: dir }), reason: "reply", stepCount: 1 } as RunTurnResult;
      };
      const complete: EscalationComplete = async (call) => {
        prompts.push(call.prompt);
        return { content: prompts.length === 1 ? review("needs-changes", "lacks evidence of the requested edit") : review("accept") };
      };
      const result = await buildFusionDelegateTool(deps(dir, complete, runTurn)).run({
        tasks: [{ id: "impl", title: "Impl", instructions: "initialize the accumulator in sales.cjs", files: ["sales.cjs"] }],
        contract: { checks: [{ task: "impl", type: "command", command: "node --test sales.test.cjs" }] },
      }, ctx(dir));
      expect(turns).toBe(2);
      expect(prompts).toHaveLength(2);
      const h12 = createHash("sha256").update(readFileSync(join(dir, "sales.cjs"))).digest("hex").slice(0, 12);
      const second = prompts[1]!;
      expect(second).toContain("## Attempts");
      expect(second).toContain(`attempt 1: wrote sales.cjs (sha256 ${h12})`);
      expect(second).toContain("attempt 2: wrote nothing");
      expect(second).toMatch(/attempt 2: .*os\.fs\.edit on sales\.cjs found its new text already present: already applied \(a no-op, not a failure\)/);
      expect(second).toContain("## Version under review");
      expect(second).toContain(`sales.cjs sha256 ${h12}: written by attempt 1; tested in attempt 1 (checks 1/1 passed), attempt 2 (checks 1/1 passed)`);
      expect((result.details.tasks as Array<{ status: string }>)[0]!.status).toBe("ok");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("a task that ends with no review verdict is listed, in the fan-out result and the milestone report", async () => {
    const dir = mkdtempSync(join(tmpdir(), "attempt-noverdict-"));
    const state = mkdtempSync(join(tmpdir(), "attempt-noverdict-state-"));
    try {
      const runsDir = join(state, "fusion-runs");
      const runTurn: FusionDelegateDeps["runTurn"] = async (session, message) => {
        if (message.includes("write the tests")) throw new Error("worker timed out");
        writeFileSync(join(dir, "sales.cjs"), `${NEW}\n`);
        return { session: createEmptySessionState({ id: session.id, workingDir: dir }), reason: "reply", stepCount: 1 } as RunTurnResult;
      };
      const result = await buildFusionDelegateTool(deps(dir, async () => ({ content: review("accept") }), runTurn, { runCheckpoints: new FusionRunStore({ dir: runsDir }) })).run({
        tasks: [
          { id: "impl", title: "Impl", instructions: "write sales.cjs", files: ["sales.cjs"] },
          { id: "tests", title: "Tests", instructions: "write the tests in sales.test.cjs", files: ["sales.test.cjs"] },
        ],
      }, ctx(dir));
      const listed = result.details.noReviewVerdict as Array<{ taskId: string; reason: string }>;
      expect(listed).toEqual([{ taskId: "tests", reason: expect.stringMatching(/^the task ended failed before review: /) }]);
      expect(result.summary).toMatch(/no review verdict: tests \(the task ended failed before review/);
      // The milestone report reads it from the run.
      const runId = result.details.runId as string;
      const evidence = readMilestoneEvidence({ runsDir, stateDir: state, runIds: [runId], criteriaOrder: [] });
      expect(evidence.noReviewVerdict).toEqual(listed);
      const [, , milestone] = buildProjectTools({
        planContext: () => { throw new Error("unused"); },
        outsideContent: () => false,
        milestoneEvidence: () => evidence,
      });
      const project = { milestones: [{ id: "m1", runIds: [runId] }], brief: { successCriteria: [] } };
      const report = await milestone!.run({ id: "m1", state: "done", summary: "Base done" }, { ...ctx(dir), project } as unknown as ToolContext);
      expect(report.summary).toContain("Warning: no review verdict: tests (the task ended failed before review");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(state, { recursive: true, force: true });
    }
  });
});
