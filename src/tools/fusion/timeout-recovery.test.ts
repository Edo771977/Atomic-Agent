/**
 * Issue #100 item 3: the first worker times out with sales.cjs already
 * written; the director's next fan-out reuses the file (a verify-only
 * re-delegation), starts the dependent tests task and keeps the valid work.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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




const PROGRAM = "// skips blank lines\nmodule.exports = (text) => text.split('\\n').filter((l) => l.trim() !== '');\n";

describe("recovery after a worker timeout (issue #100)", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("the timed-out program is reused, the dependent tests task runs, the valid work is kept", async () => {
    const dir = mkdtempSync(join(tmpdir(), "timeout-recovery-"));
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      const started: string[] = [];
      let call = 1;
      const runTurn: FusionDelegateDeps["runTurn"] = async (session, message, options) => {
        const task = message.includes("write the tests") ? "tests" : "program";
        started.push(`${call}:${task}`);
        options.eventHook?.({ type: "turn_started", turnIndex: 0 } as never);
        options.eventHook?.({ type: "step_finished", stepIndex: 0, summary: "", durationMs: 1 } as never);
        if (task === "program" && call === 1) {
          writeFileSync(join(dir, "sales.cjs"), PROGRAM);
          // The worker hangs after writing: its own clock ends it.
          await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
          return { session: createEmptySessionState({ id: session.id, workingDir: dir }), reason: "cancelled", stepCount: 1 } as RunTurnResult;
        }
        if (task === "tests") writeFileSync(join(dir, "sales.test.cjs"), "require('node:test')('sums', () => {});\n");
        return { session: createEmptySessionState({ id: session.id, workingDir: dir }), reason: "reply", stepCount: 1 } as RunTurnResult;
      };
      const runChecks: FusionDelegateDeps["runChecks"] = async (specs) => ({ ok: true, results: specs.map(() => ({ ok: true, summary: "passed" })) });
      const tool = buildFusionDelegateTool(deps(dir, async () => ({ content: review("accept") }), runTurn, { runChecks }));
      const tasks = (verify: boolean) => [
        { id: "program", title: "Program", instructions: verify ? "verify sales.cjs; change nothing" : "write sales.cjs", files: ["sales.cjs"], ...(verify ? { verifyOnly: true } : {}) },
        { id: "tests", title: "Tests", instructions: "write the tests in sales.test.cjs", files: ["sales.test.cjs"], dependsOn: ["program"] },
      ];
      const contract = { checks: [{ task: "program", type: "command", command: "node --test sales.test.cjs" }] };
      const first = tool.run({ tasks: tasks(false), contract }, ctx(dir));
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      const one = (await first).details.tasks as Array<{ id: string; status: string; error?: string }>;
      // The program timed out with its file written; the dependent tests task still ran on it.
      expect(one.find((r) => r.id === "program")!.status).toBe("timeout");
      expect(one.find((r) => r.id === "tests")!.status).toBe("ok");
      expect(started).toEqual(["1:program", "1:tests"]);
      vi.useRealTimers();
      // The director reuses the file: a verify-only program task, which keeps it as it is.
      call = 2;
      const two = (await tool.run({ tasks: tasks(true).slice(0, 1), contract }, ctx(dir))).details.tasks as Array<{ id: string; status: string }>;
      expect(started).toEqual(["1:program", "1:tests", "2:program"]);
      // Done (`ok`, or `no_changes` once the file's time predates the run): not a failure, the file kept.
      expect(["ok", "no_changes"]).toContain(two[0]!.status);
      expect(readFileSync(join(dir, "sales.cjs"), "utf8")).toBe(PROGRAM);
      expect(readFileSync(join(dir, "sales.test.cjs"), "utf8")).toContain("sums");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
