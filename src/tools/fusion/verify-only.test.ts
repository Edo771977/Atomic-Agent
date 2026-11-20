/**
 * Issue #100 item 2: a verify-only task must not replace a validated file
 * with one that fails its checks: the runtime reruns the task's own checks
 * on a changed file and restores the verified version when they fail.
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



const VERIFIED = "// skips blank lines\nmodule.exports = (text) => text.split('\\n').filter((l) => l.trim() !== '');\n";
const REGRESSED = "module.exports = (text) => text.split('\\n');\n";

async function verify(rewrite: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "verify-only-"));
  try {
    writeFileSync(join(dir, "sales.cjs"), VERIFIED);
    const runTurn: FusionDelegateDeps["runTurn"] = async (session, _m, options) => {
      if (rewrite !== null) {
        writeFileSync(join(dir, "sales.cjs"), rewrite);
        options.eventHook?.({ type: "llm_event", event: { type: "tool_call_parsed", call: { tool: "os.fs.write", args: { path: "sales.cjs", content: rewrite } }, batchIndex: 0, batchSize: 1 } } as never);
        options.eventHook?.({ type: "llm_event", event: { type: "tool_call_executed", result: { tool: "os.fs.write", status: "ok", summary: "", details: {}, truncated: false }, batchIndex: 0, batchSize: 1 } } as never);
      }
      return { session: createEmptySessionState({ id: session.id, workingDir: dir }), reason: "reply", stepCount: 1 } as RunTurnResult;
    };
    // The program's own check: blank lines must be skipped.
    const runChecks: FusionDelegateDeps["runChecks"] = async (specs) => {
      const ok = readFileSync(join(dir, "sales.cjs"), "utf8").includes("filter(");
      return { ok, results: specs.map(() => ({ ok, summary: ok ? "10 passed" : "blank lines: 1 failed" })) };
    };
    const result = await buildFusionDelegateTool(deps(dir, async () => ({ content: review("accept") }), runTurn, { runChecks })).run({
      tasks: [{ id: "program", title: "Program", instructions: "verify sales.cjs against its suite; change nothing", files: ["sales.cjs"], verifyOnly: true }],
      contract: { checks: [{ task: "program", type: "command", command: "node --test sales.test.cjs" }] },
    }, ctx(dir));
    const row = (result.details.tasks as Array<{ status: string; notes?: string[] }>)[0]!;
    return { row, file: readFileSync(join(dir, "sales.cjs"), "utf8") };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("a verify-only task keeps the validated version of its files (issue #100)", () => {
  it("a rewrite that drops the blank-line handling fails its checks: the verified version is restored", async () => {
    const { row, file } = await verify(REGRESSED);
    expect(file).toBe(VERIFIED);
    expect(row.notes?.join(" ")).toMatch(/verify-only: restored the verified sales\.cjs/);
  });

  it("a change that still passes the task's own checks is kept", async () => {
    const better = VERIFIED.replace("// skips blank lines", "// skips blank and whitespace-only lines");
    const { file, row } = await verify(better);
    expect(file).toBe(better);
    expect(row.notes?.join(" ") ?? "").not.toMatch(/restored/);
  });

  it("no change: nothing to restore", async () => {
    const { file } = await verify(null);
    expect(file).toBe(VERIFIED);
  });
});
