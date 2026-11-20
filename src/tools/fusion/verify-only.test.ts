/**
 * Issue #100 item 2: a verify-only task must not replace a validated file
 * with one that fails its checks: the runtime reruns the task's own checks
 * on a changed file and restores the verified version when they fail.
 */
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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

type After = "none" | "symlink" | "person-edit" | "cancel";

/** A verify-only run of the program task; `rewrite` is what its worker writes, `after` what happens next. */
async function verify(rewrite: string | null, after: After = "none", over: Partial<FusionDelegateDeps> = {}, isolation = false) {
  const root = mkdtempSync(join(tmpdir(), "verify-only-"));
  const dir = join(root, "work");
  const outside = join(root, "outside.txt");
  try {
    mkdirSync(dir);
    writeFileSync(join(dir, "sales.cjs"), VERIFIED);
    writeFileSync(outside, "the person's notes\n");
    const controller = new AbortController();
    let turns = 0;
    const runTurn: FusionDelegateDeps["runTurn"] = async (session, _m, options) => {
      const target = join(session.workingDir, "sales.cjs");
      // Only the first turn acts; a self-check grace turn changes nothing more.
      if (turns++ > 0) return { session: createEmptySessionState({ id: session.id, workingDir: session.workingDir }), reason: "reply", stepCount: 1 } as RunTurnResult;
      if (rewrite !== null) {
        writeFileSync(target, rewrite);
        options.eventHook?.({ type: "llm_event", event: { type: "tool_call_parsed", call: { tool: "os.fs.write", args: { path: "sales.cjs", content: rewrite } }, batchIndex: 0, batchSize: 1 } } as never);
        options.eventHook?.({ type: "llm_event", event: { type: "tool_call_executed", result: { tool: "os.fs.write", status: "ok", summary: "", details: {}, truncated: false }, batchIndex: 0, batchSize: 1 } } as never);
      }
      if (after === "symlink") { unlinkSync(target); symlinkSync(outside, target); }
      if (after === "person-edit") writeFileSync(target, "// the person's own edit\n");
      if (after === "cancel") controller.abort();
      return { session: createEmptySessionState({ id: session.id, workingDir: session.workingDir }), reason: after === "cancel" ? "cancelled" : "reply", stepCount: 1 } as RunTurnResult;
    };
    // The program's own check, which ran and exited 1 when blank lines are not skipped.
    const runChecks: FusionDelegateDeps["runChecks"] = async (specs, run) => {
      const ok = readFileSync(join(run.workingDir, "sales.cjs"), "utf8").includes("filter(");
      return { ok, results: specs.map(() => ({ ok, summary: ok ? "10 passed" : "verify.run command: FAILED (exit 1): blank lines: 1 failed" })) };
    };
    let minted = 0;
    const d = deps(dir, async () => ({ content: review("accept") }), runTurn, {
      runChecks,
      // The worker's session in its own folder (an isolated workspace when there is one).
      createEphemeralSession: (meta, workingDir) => {
        minted += 1;
        return createEmptySessionState({ id: `${FUSION_WORKER_ID_PREFIX}v${minted}`, workingDir: workingDir ?? dir, metadata: { fusionWorker: { ...meta } } });
      },
      ...over,
    });
    const baseMode = d.resolveRunMode;
    if (isolation) d.resolveRunMode = () => ({ ...baseMode(), isolation: "worktree" as const });
    const result = await buildFusionDelegateTool(d).run({
      tasks: [{ id: "program", title: "Program", instructions: "verify sales.cjs against its suite; change nothing", files: ["sales.cjs"], verifyOnly: true }],
      contract: { checks: [{ task: "program", type: "command", command: "node --test sales.test.cjs" }] },
    }, { ...ctx(dir), signal: controller.signal });
    const row = (result.details.tasks as Array<{ status: string; failure?: string; notes?: string[]; error?: string }>)[0]!;
    const link = lstatSync(join(dir, "sales.cjs")).isSymbolicLink();
    return { row, link, file: readFileSync(join(dir, "sales.cjs"), "utf8"), outside: readFileSync(outside, "utf8"), leftovers: readdirSync(dir) };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const said = (row: { notes?: string[]; error?: string }) => [...(row.notes ?? []), row.error ?? ""].join(" ");

describe("a verify-only task keeps the validated version of its files (issue #100)", () => {
  it("project mode, every condition met: the verified version is restored, and the row is regressed-verified, never ok", async () => {
    const { row, file, leftovers } = await verify(REGRESSED);
    expect(file).toBe(VERIFIED);
    expect(row).toMatchObject({ status: "failed", failure: "regressed-verified" });
    expect(said(row)).toMatch(/verify-only: the change to sales\.cjs failed its own checks; the verified version was restored/);
    // Written through a temp file renamed into place: nothing left beside it.
    expect(leftovers.sort()).toEqual(["sales.cjs"]);
  });

  it("a symlink swapped in after the write is refused: nothing outside is written", async () => {
    const { row, link, outside } = await verify(REGRESSED, "symlink");
    expect(link).toBe(true);
    expect(outside).toBe("the person's notes\n");
    expect(row).toMatchObject({ failure: "regressed-verified" });
    expect(said(row)).toMatch(/not restored: sales\.cjs is not a regular file/);
  });

  it("a person's edit after the worker's write is never overwritten", async () => {
    const { row, file } = await verify(REGRESSED, "person-edit");
    expect(file).toBe("// the person's own edit\n");
    expect(said(row)).toMatch(/not restored: sales\.cjs changed after the worker's last write/);
  });

  it("a cancelled turn writes nothing back", async () => {
    const { file, row } = await verify(REGRESSED, "cancel");
    expect(file).toBe(REGRESSED);
    expect(said(row)).not.toMatch(/restored/);
  });

  it("under isolation nothing is written back and the failing change is not merged", async () => {
    const { file, row } = await verify(REGRESSED, "none", {}, true);
    expect(file).toBe(VERIFIED);
    expect(row).toMatchObject({ status: "failed", failure: "regressed-verified" });
    expect(said(row)).toMatch(/not restored: an isolated workspace; the change is not merged/);
  });

  it("a change that still passes the task's own checks is kept", async () => {
    const better = VERIFIED.replace("// skips blank lines", "// skips blank and whitespace-only lines");
    const { file, row } = await verify(better);
    expect(file).toBe(better);
    expect(said(row)).not.toMatch(/restored|regressed/);
  });

  it("no change: nothing to restore", async () => {
    const { file } = await verify(null);
    expect(file).toBe(VERIFIED);
  });
});
