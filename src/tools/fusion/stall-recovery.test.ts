/**
 * Issue #98 item 2: a stalled worker whose file is good (its last check
 * passed after its last change), or one that keeps re-running a green
 * check on unchanged files, is kept as done; its dependents run and both
 * reach review.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { captureError } from "../../error-reporting/error-reporter.js";
import type { SentryClient } from "../../error-reporting/sentry-client.js";

import { FanoutScopeRegistry } from "../../approval/fanout-scope.js";
import type { RunTurnResult } from "../../agent/agent-loop.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import { FUSION_WORKER_ID_PREFIX } from "../../session/fusion-worker-session.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import type { ToolContext } from "../tool-registry.js";
import type { EscalationComplete } from "./escalation.js";
import { buildFusionDelegateTool, type FusionDelegateDeps } from "./fusion-delegate.js";
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


const write = (path: string, content: string, i: number) => [
  { type: "llm_event", event: { type: "tool_call_parsed", call: { tool: "os.fs.write", args: { path, content } }, batchIndex: 0, batchSize: 1 } },
  { type: "llm_event", event: { type: "tool_call_executed", result: { tool: "os.fs.write", status: "ok", summary: "", details: {}, truncated: false }, batchIndex: 0, batchSize: 1 } },
  { type: "step_finished", stepIndex: i, summary: "", durationMs: 1 },
] as never[];
const verify = (command: string, i: number) => [
  { type: "llm_event", event: { type: "tool_call_parsed", call: { tool: "verify.run", args: { type: "command", command } }, batchIndex: 0, batchSize: 1 } },
  { type: "llm_event", event: { type: "tool_call_executed", result: { tool: "verify.run", status: "ok", summary: "6 passed", details: {}, truncated: false }, batchIndex: 0, batchSize: 1 } },
  { type: "step_finished", stepIndex: i, summary: "", durationMs: 1 },
] as never[];

describe("a stalled program whose file is good is kept as done; its dependents run (issue #98)", () => {
  for (const variant of ["identical writes", "green checks"] as const) {
    it(`${variant} after a passing check: the program is kept, the dependent test task runs, both are reviewed`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "stall-recovery-"));
      try {
        const started: string[] = [];
        let programEvents = 0;
        let stop: unknown;
        const prompts: string[] = [];
        const program = "module.exports = (rows) => rows.length;\n";
        const runTurn: FusionDelegateDeps["runTurn"] = async (session, message, options) => {
          const hook = options.eventHook!;
          hook({ type: "turn_started", turnIndex: 0 } as never);
          const task = message.includes("write the tests") ? "tests" : "program";
          started.push(task);
          const done = () => ({ session: createEmptySessionState({ id: session.id, workingDir: dir }), reason: options.signal?.aborted === true ? "cancelled" : "reply", stepCount: 3 }) as RunTurnResult;
          if (task === "tests") {
            writeFileSync(join(dir, "sales.test.cjs"), "require('node:test')('sums', () => {});\n");
            for (const e of write("sales.test.cjs", "tests", 0)) hook(e);
            return done();
          }
          writeFileSync(join(dir, "sales.cjs"), program);
          let i = 0;
          for (const e of write("sales.cjs", program, i++)) hook(e);
          for (const e of verify("node --test sales.test.cjs sales.cjs", i++)) hook(e);
          for (let n = 0; n < 12; n += 1) {
            if (options.signal?.aborted === true) {
              stop = options.signal.reason;
              return done();
            }
            programEvents += 1;
            const events = variant === "identical writes" ? write("sales.cjs", program, i++) : verify("node --test sales.test.cjs sales.cjs", i++);
            for (const e of events) hook(e);
          }
          return done();
        };
        const complete: EscalationComplete = async (call) => {
          prompts.push(call.prompt);
          return { content: review("accept") };
        };
        const result = await buildFusionDelegateTool(deps(dir, complete, runTurn)).run({
          tasks: [
            { id: "program", title: "Program", instructions: "write sales.cjs", files: ["sales.cjs"] },
            { id: "tests", title: "Tests", instructions: "write the tests in sales.test.cjs", files: ["sales.test.cjs"], dependsOn: ["program"] },
          ],
          // The program's own check: the green-check rule counts only these (issue #98 review).
          contract: { checks: [{ task: "program", type: "command", command: "node --test sales.test.cjs sales.cjs" }] },
        }, ctx(dir));
        const rows = result.details.tasks as Array<{ id: string; status: string; failure?: string; notes?: string[]; stalled?: unknown }>;
        const prog = rows.find((r) => r.id === "program")!;
        // Stopped early, but kept as done with its artifact.
        expect(programEvents).toBeLessThan(12);
        const capture = vi.fn();
        captureError({ capture } as unknown as SentryClient, new Error("fixture wrapper", { cause: stop }), { source: "llm_failure" });
        expect(capture).not.toHaveBeenCalled();
        expect(stop).toMatchObject({ reason: variant === "identical writes" ? "repeated-writes" : "passed-and-current" });
        expect(prog.status).toBe("ok");
        expect(prog.failure).toBeUndefined();
        expect(prog.notes?.join(" ")).toMatch(variant === "identical writes" ? /stalled: repeated identical writes.*kept as done/ : /passed and current/);
        // The dependent ran, and both reached review.
        expect(started).toEqual(["program", "tests"]);
        expect(rows.find((r) => r.id === "tests")!.status).toBe("ok");
        expect(prompts).toHaveLength(2);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }

  describe("the green-check rule counts only the task's own checks, after a write (issue #98 review)", () => {
    const runProgram = async (script: (hook: (e: never) => void, aborted: () => boolean) => void, contract?: unknown) => {
      const dir = mkdtempSync(join(tmpdir(), "green-rule-"));
      try {
        let aborted = false;
        const runTurn: FusionDelegateDeps["runTurn"] = async (session, _m, options) => {
          options.eventHook!({ type: "turn_started", turnIndex: 0 } as never);
          script(options.eventHook! as never, () => options.signal?.aborted === true);
          aborted = options.signal?.aborted === true;
          return { session: createEmptySessionState({ id: session.id, workingDir: dir }), reason: "reply", stepCount: 3 } as RunTurnResult;
        };
        const result = await buildFusionDelegateTool(deps(dir, async () => ({ content: review("accept") }), runTurn)).run({
          tasks: [{ id: "program", title: "Program", instructions: "write sales.cjs", files: ["sales.cjs"] }],
          ...(contract === undefined ? {} : { contract }),
        }, ctx(dir));
        return { aborted, row: (result.details.tasks as Array<{ status: string; failure?: string; notes?: string[] }>)[0]! };
      } finally { rmSync(dir, { recursive: true, force: true }); }
    };
    const own = { checks: [{ task: "program", type: "command", command: "node --test sales.test.cjs" }] };

    it("a check that is not the task's own (`node -e 0`) never stops it as done", async () => {
      const { aborted, row } = await runProgram((hook) => {
        for (const e of write("sales.cjs", "x", 0)) hook(e);
        for (let i = 1; i < 6; i += 1) for (const e of verify("node -e 0", i)) hook(e);
      }, own);
      expect(aborted).toBe(false);
      expect(row.notes?.join(" ") ?? "").not.toMatch(/passed and current/);
    });

    it("its own check passing before any write never stops it as done", async () => {
      // (A worker that only reads may be handed back for that; it is never "passed and current".)
      const { row } = await runProgram((hook) => {
        for (let i = 0; i < 5; i += 1) for (const e of verify("node --test sales.test.cjs", i)) hook(e);
      }, own);
      expect(row.notes?.join(" ") ?? "").not.toMatch(/passed and current/);
    });

    it("a stalled write whose check does not name the file stays stuck, whatever the checks did", async () => {
      const { row } = await runProgram((hook, aborted) => {
        for (const e of write("sales.cjs", "x", 0)) hook(e);
        for (const e of verify("node --test sales.test.cjs", 1)) hook(e);
        for (let i = 2; i < 12 && !aborted(); i += 1) for (const e of write("sales.cjs", "x", i)) hook(e);
      }, own);
      expect(row).toMatchObject({ status: "failed", failure: "stuck" });
    });
  });
});

