/**
 * Issue #95 item 3: the reviewer sees which attempt changed each file and
 * which version was tested, across review passes; a task that ends with no
 * review verdict is listed, in the fan-out result and the milestone report.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
import { ATTEMPT_EVIDENCE_CHARS, AttemptFilesTracker, evidencePath, renderAttemptEvidence, type AttemptRecord } from "./attempt-evidence.js";
import { buildProjectTools } from "./project-tools.js";
import { FusionRunStore } from "./run-checkpoint.js";
import { readMilestoneEvidence, writeRunCriteriaFacts } from "./run-criteria.js";
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
/** The edit tool's outcomes: applied, already applied (its own flag), or a plain miss. */
const executedEdit = (outcome: "applied" | "already-applied" | "not-found") => ({
  type: "llm_event",
  event: {
    type: "tool_call_executed",
    result: outcome === "not-found"
      ? { tool: "os.fs.edit", status: "error", summary: "os.fs.edit: `oldString` was not found in the target file.", details: {}, truncated: false }
      : { tool: "os.fs.edit", status: "ok", summary: outcome === "applied" ? "edited" : "note: oldString was not found, but newString is already in the file", details: outcome === "applied" ? {} : { matchedBy: "already-applied" }, truncated: false },
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
        // The retry finds the old text gone: the edit tool says it is already there.
        options.eventHook?.(executedEdit(turns === 1 ? "applied" : "already-applied"));
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
      expect(second).toContain(`sales.cjs sha256 ${h12}: written by attempt 1; tested in attempt 1 (checks 1/1 passed), 2 (checks 1/1 passed)`);
      expect((result.details.tasks as Array<{ status: string }>)[0]!.status).toBe("ok");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("only the edit tool's own flag counts as already applied: a miss stays a miss", async () => {
    const dir = mkdtempSync(join(tmpdir(), "attempt-miss-"));
    try {
      // The new text is in the file, but the tool reported a plain miss (a typo, several places…).
      writeFileSync(join(dir, "sales.cjs"), `${NEW}\n`);
      let turns = 0;
      const prompts: string[] = [];
      const runTurn: FusionDelegateDeps["runTurn"] = async (session, _m, options) => {
        turns += 1;
        options.eventHook?.(parsedEdit);
        options.eventHook?.(executedEdit("not-found"));
        return { session: createEmptySessionState({ id: session.id, workingDir: dir }), reason: "reply", stepCount: 1 } as RunTurnResult;
      };
      const complete: EscalationComplete = async (call) => {
        prompts.push(call.prompt);
        return { content: prompts.length === 1 ? review("needs-changes", "edit missing") : review("accept") };
      };
      await buildFusionDelegateTool(deps(dir, complete, runTurn)).run({
        tasks: [{ id: "impl", title: "Impl", instructions: "initialize the accumulator in sales.cjs", files: ["sales.cjs"] }],
      }, ctx(dir));
      expect(turns).toBe(2);
      expect(prompts.join("\n")).not.toMatch(/already applied/);
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

  it("keeps the attempts section within its own budget, the task's files first, the rest counted", () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ path: `gen/file-${i}.js`, sha256: "a".repeat(64) }));
    const attempts: AttemptRecord[] = Array.from({ length: 6 }, (_, i) => ({
      attempt: i + 1,
      wrote: [...many, { path: "sales.cjs", sha256: "b".repeat(64) }],
      alreadyApplied: [],
      tested: { passed: 1, total: 1, versions: [...many, { path: "sales.cjs", sha256: "b".repeat(64) }] },
    }));
    const text = renderAttemptEvidence(attempts, [...many, { path: "sales.cjs", sha256: "b".repeat(64) }], ["sales.cjs"]);
    expect(ATTEMPT_EVIDENCE_CHARS).toBeLessThanOrEqual(4_000);
    expect(text.length).toBeLessThanOrEqual(ATTEMPT_EVIDENCE_CHARS);
    // The task's own file leads every list, and what does not fit is counted.
    expect(text).toContain("attempt 1: wrote sales.cjs (sha256 bbbbbbbbbbbb)");
    expect(text).toMatch(/\+\d+ files/);
    expect(text).toContain("## Version under review\n- sales.cjs sha256 bbbbbbbbbbbb");
  });

  it("reviews across runs: a later run that covers the task's criteria, or reviews the task, clears its no-verdict warning", () => {
    const state = mkdtempSync(join(tmpdir(), "attempt-reviews-"));
    try {
      const runsDir = join(state, "fusion-runs");
      const read = (runIds: string[]) => readMilestoneEvidence({ runsDir, stateDir: state, runIds, criteriaOrder: ["c1", "c2"] }).noReviewVerdict;
      writeRunCriteriaFacts(runsDir, { runId: "fr-1", sessionId: "s" }, [], undefined, [
        { taskId: "tests", verdict: "none", reason: "the task ended failed before review: timed out", criteria: ["c1"] },
        { taskId: "docs", verdict: "none", reason: "not judged" },
      ]);
      expect(read(["fr-1"])).toEqual([
        { taskId: "tests", reason: "the task ended failed before review: timed out" },
        { taskId: "docs", reason: "not judged" },
      ]);
      // The fix came under another task id, and its run covered c1.
      writeRunCriteriaFacts(runsDir, { runId: "fr-2", sessionId: "s" }, [{ taskId: "tests-fix", facts: [{ id: "c1", state: "passed" }] }], undefined, [
        { taskId: "tests-fix", verdict: "accept" },
      ]);
      expect(read(["fr-1", "fr-2"])).toEqual([{ taskId: "docs", reason: "not judged" }]);
      // Read in the other order, the old run is the newest: its warning stands.
      expect(read(["fr-2", "fr-1"])).toHaveLength(2);
      // A later run that reviews the task itself clears it too.
      writeRunCriteriaFacts(runsDir, { runId: "fr-3", sessionId: "s" }, [], undefined, [{ taskId: "docs", verdict: "accept" }]);
      expect(read(["fr-1", "fr-2", "fr-3"])).toBeUndefined();
    } finally { rmSync(state, { recursive: true, force: true }); }
  });

  it("reads and names only paths inside the working dir or a read root", () => {
    const root = mkdtempSync(join(tmpdir(), "attempt-roots-"));
    try {
      const dir = join(root, "work");
      const extra = join(root, "shared");
      for (const d of [dir, extra]) mkdirSync(d);
      writeFileSync(join(dir, "a.js"), "inside");
      writeFileSync(join(root, "outside.txt"), "secret");
      writeFileSync(join(extra, "lib.js"), "shared");
      expect(evidencePath([dir], "a.js")).toEqual({ display: "a.js", full: join(dir, "a.js") });
      expect(evidencePath([dir], join(dir, "a.js"))).toEqual({ display: "a.js", full: join(dir, "a.js") });
      expect(evidencePath([dir], "../outside.txt")).toBeUndefined();
      expect(evidencePath([dir], join(root, "outside.txt"))).toBeUndefined();
      expect(evidencePath([dir, extra], join(extra, "lib.js"))?.full).toBe(join(extra, "lib.js"));
      const tracker = new AttemptFilesTracker(dir);
      const ok = { tool: "os.fs.write", status: "ok" };
      for (const [i, path] of ["a.js", "../outside.txt", join(root, "outside.txt"), "./a.js"].entries()) {
        tracker.observeParsed({ tool: "os.fs.write", args: { path, content: "x" } }, i);
        tracker.observeExecuted(ok, i);
      }
      expect(tracker.finish()?.wrote.map((w) => w.path)).toEqual(["a.js"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("a re-delegated task that changes nothing is re-reviewed on its unchanged files (issue #98)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "attempt-rereview-"));
    try {
      writeFileSync(join(dir, "sales.test.cjs"), "test('sums', () => {});\n");
      // Written by an earlier attempt, well before this one.
      utimesSync(join(dir, "sales.test.cjs"), new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
      const prompts: string[] = [];
      const runTurn: FusionDelegateDeps["runTurn"] = async (session) =>
        ({ session: createEmptySessionState({ id: session.id, workingDir: dir }), reason: "reply", stepCount: 1 }) as RunTurnResult;
      const complete: EscalationComplete = async (call) => {
        prompts.push(call.prompt);
        return { content: review("accept") };
      };
      const result = await buildFusionDelegateTool(deps(dir, complete, runTurn)).run({
        tasks: [{ id: "tests", title: "Tests", instructions: "report the suite's counts for sales.test.cjs", files: ["sales.test.cjs"] }],
        contract: { checks: [{ task: "tests", type: "command", command: "node --test sales.test.cjs" }] },
      }, ctx(dir));
      const row = (result.details.tasks as Array<{ status: string; review?: { decision: string } }>)[0]!;
      expect(row.status).toBe("no_changes");
      expect(prompts).toHaveLength(1);
      expect(row.review?.decision).toBe("accept");
      expect(result.details.noReviewVerdict).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

