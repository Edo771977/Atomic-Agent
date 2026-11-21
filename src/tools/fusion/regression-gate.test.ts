/**
 * Issue #106: a change must not break a case that already passed. In the
 * live run the first program accepted `X,9007199254740993,0` (price 0,
 * total 0) and the final files rejected it with `Invalid row 2`. A fix
 * round re-runs every contract check that passed on the reviewed version
 * of the milestone's files, not only the task's own checks of the call.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
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

const up = (p: ProjectState | undefined, u: ProjectUpdate): ProjectState => {
  const r = applyProjectUpdate(p, u, Date.now());
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
};
const approve = (p: ProjectState): ProjectState => {
  const r = applyProjectDecision(p, { gate: p.gate, version: gateVersion(p)!, verdict: "approve" }, { now: Date.now() });
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
};
const projectOf = (): ProjectState => approve(up(approve(up(undefined, {
  kind: "brief", brief: { what: "CSV sales", users: "ops", how: "node", successCriteria: ["a zero price totals zero"] }, draftedAfterUntrusted: false,
})), { kind: "plan", milestones: [{ id: "m1", title: "CLI", kind: "base" }], detail: "compact",
  rows: [{ taskId: "program", title: "Program", milestoneId: "m1", worker: "local:small", reviewer: "cli-b:model-r", reason: "preset", basis: "preset", samples: 0, estCostUsd: 0, estMs: 1000 }] }));

/** The zero-price case: `X,9007199254740993,0` gives exit 0 and {"X":0}. */
const ZERO_PRICE = { task: "program", kind: "command", cmd: "node", args: ["check-zero-price.cjs"] };
const OTHER = { task: "program", kind: "command", cmd: "node", args: ["check-blank-lines.cjs"] };
const V1 = "// accepts a zero price: X,9007199254740993,0 -> {\"X\":0}\nmodule.exports = 1;\n";
const V2_BROKEN = "// rejects rows with a huge quantity: Invalid row 2\nmodule.exports = 2;\n";
const V2_KEEPS = `${V1}// and skips blank lines\n`;

function milestone(dir: string, opts: { candidate?: boolean; holdZero?: () => boolean } = {}) {
  const runsDir = join(dir, "..", "runs");
  let write = V1;
  let turns = 0;
  let minted = 0;
  const ev = (event: Record<string, unknown>) => ({ type: "llm_event", event: { batchIndex: 0, batchSize: 1, ...event } }) as never;
  let started = new Set<string>();
  const runTurn: FusionDelegateDeps["runTurn"] = async (session, message, options) => {
    // Each task's worker acts on its first turn only; a docs task writes its own file.
    const file = message.includes("write docs.md") ? "docs.md" : "sales.cjs";
    turns += 1;
    if (!started.has(file)) {
      started.add(file);
      const content = file === "docs.md" ? "# sales\n" : write;
      options.eventHook?.({ type: "turn_started", turnIndex: 0 } as never);
      options.eventHook?.(ev({ type: "tool_call_parsed", call: { tool: "os.fs.write", args: { path: file, content } } }));
      // The worker's own folder: a candidate run's private workspace, else the project's.
      writeFileSync(join(session.workingDir, file), content);
      options.eventHook?.(ev({ type: "tool_call_executed", result: { tool: "os.fs.write", status: "ok", summary: "", details: {}, truncated: false } }));
      options.eventHook?.({ type: "step_finished", stepIndex: 0, summary: "", durationMs: 1 } as never);
    }
    return { session: createEmptySessionState({ id: session.id, workingDir: dir }), reason: "reply", stepCount: 1 } as RunTurnResult;
  };
  // The zero-price check reads the program: it passes only while the program accepts a zero price.
  const ran: string[] = [];
  const runChecks: FusionDelegateDeps["runChecks"] = async (specs, run) => {
    if (opts.holdZero?.() === true && specs.some((spec) => JSON.stringify(spec).includes("check-zero-price.cjs"))) {
      throw new Error("the check runner is unavailable");
    }
    return {
    ok: true,
    results: specs.map((spec) => {
      const zero = JSON.stringify(spec).includes("check-zero-price.cjs");
      ran.push(zero ? "zero-price" : "other");
      // A check naming an absolute script reads the program beside it, as a real one would.
      const script = Array.isArray(spec.args) ? String(spec.args[0]) : "";
      const base = isAbsolute(script) ? dirname(script) : run.workingDir;
      let program = "";
      try { program = readFileSync(join(base, "sales.cjs"), "utf8"); } catch { program = ""; }
      const ok = !zero || program.includes("accepts a zero price");
      return ok ? { ok: true, summary: "passed", exitCode: 0 } : { ok: false, summary: "verify.run command: FAILED (exit 1): Invalid row 2", exitCode: 1 };
    }),
    };
  };
  let reviewer = review("needs-changes", "the summary line is missing");
  const tool = buildFusionDelegateTool(deps(dir, async () => ({ content: reviewer }), runTurn, {
    runChecks,
    runCheckpoints: new FusionRunStore({ dir: runsDir }),
    createEphemeralSession: (meta, workingDir) => createEmptySessionState({ id: `${FUSION_WORKER_ID_PREFIX}r${++minted}`, workingDir: workingDir ?? dir, metadata: { fusionWorker: { ...meta } } }),
    ...(opts.candidate === true ? { resolveRunMode: () => ({ ...mode(), integration: "candidate" as const }) } : {}),
  }));
  let p = projectOf();
  let rows: Array<{ id: string; status: string; failure?: string; error?: string; notes?: string[] }> = [];
  return {
    ran,
    get rows() { return rows; },
    async round(content: string, checks: readonly Record<string, unknown>[], answer: string, withDocs = false) {
      write = content;
      turns = 0;
      started = new Set();
      reviewer = answer;
      const tasks = [
        { id: "program", title: "Program", instructions: "write sales.cjs", files: ["sales.cjs"] },
        ...(withDocs ? [{ id: "docs", title: "Docs", instructions: "write docs.md", files: ["docs.md"] }] : []),
      ];
      const result = await tool.run({ tasks, contract: { checks: [...checks] } }, { ...ctx(dir), project: p });
      rows = result.details.tasks as Array<{ id: string; status: string; failure?: string; error?: string; notes?: string[] }>;
      // The fold the director's turn applies: the delegate's own milestone_run update.
      p = up(p, result.details.projectUpdate as ProjectUpdate);
      return (result.details.tasks as Array<{ id: string; status: string; failure?: string; error?: string; notes?: string[] }>)[0]!;
    },
  };
}

describe("a change must not break a case that already passed (issue #106)", () => {
  it("version 1 passes the zero-price check; the fix round breaks it: the row fails, naming the check", async () => {
    const root = mkdtempSync(join(tmpdir(), "regression-gate-"));
    const dir = join(root, "work");
    try {
      mkdirSync(dir);
      const m = milestone(dir);
      const first = await m.round(V1, [ZERO_PRICE], review("needs-changes", "the summary line is missing"));
      expect(first.failure).not.toBe("regressed-check");
      // The fix round's contract no longer names the zero-price check.
      m.ran.length = 0;
      const fix = await m.round(V2_BROKEN, [OTHER], review("accept"));
      expect(m.ran).toContain("zero-price");
      expect(fix).toMatchObject({ status: "failed", failure: "regressed-check" });
      expect(fix.error).toMatch(/^regressed: node check-zero-price\.cjs \(verify\.run command: FAILED \(exit 1\): Invalid row 2\)/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("a fix that keeps the case passing is not a regression", async () => {
    const root = mkdtempSync(join(tmpdir(), "regression-gate-ok-"));
    const dir = join(root, "work");
    try {
      mkdirSync(dir);
      const m = milestone(dir);
      await m.round(V1, [ZERO_PRICE], review("needs-changes", "the summary line is missing"));
      const fix = await m.round(V2_KEEPS, [OTHER], review("accept"));
      expect(fix.status).toBe("ok");
      expect(fix.failure).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("in candidate integration, a check is kept as the contract wrote it, not as rebased into the call's private workspace (issue #106 review)", async () => {
    const root = mkdtempSync(join(tmpdir(), "regression-gate-candidate-"));
    const dir = join(root, "work");
    try {
      mkdirSync(dir);
      // The check names its script by an absolute path in the project folder.
      const zeroAbs = { ...ZERO_PRICE, args: [join(dir, "check-zero-price.cjs")] };
      const m = milestone(dir, { candidate: true });
      const first = await m.round(V1, [zeroAbs], review("accept"));
      expect(first.status).toBe("ok");
      expect(readFileSync(join(dir, "sales.cjs"), "utf8")).toBe(V1);
      // A fix that keeps the case: the kept check runs on the files now, never on the deleted workspace.
      const fix = await m.round(V2_KEEPS, [OTHER], review("accept"));
      expect(fix.failure).toBeUndefined();
      expect(fix.status).toBe("ok");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("a regression check that could not run says so on the changed row (issue #106 review)", async () => {
    const root = mkdtempSync(join(tmpdir(), "regression-gate-held-"));
    const dir = join(root, "work");
    try {
      mkdirSync(dir);
      let hold = false;
      const m = milestone(dir, { holdZero: () => hold });
      await m.round(V1, [ZERO_PRICE], review("needs-changes", "the summary line is missing"));
      hold = true;
      const fix = await m.round(V2_BROKEN, [OTHER], review("accept"));
      expect(fix.failure).toBeUndefined();
      expect((fix.notes ?? []).join("\n")).toMatch(/regression checks not run: 1 check not run — the check runner failed: the check runner is unavailable; a case that passed on the reviewed version is not known to pass now/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("only the row of the regressed check's own task fails; another changed row is not blamed (issue #106 review)", async () => {
    const root = mkdtempSync(join(tmpdir(), "regression-gate-blame-"));
    const dir = join(root, "work");
    try {
      mkdirSync(dir);
      const m = milestone(dir);
      await m.round(V1, [ZERO_PRICE], review("needs-changes", "the summary line is missing"));
      await m.round(V2_BROKEN, [OTHER], review("accept"), true);
      const byId = Object.fromEntries(m.rows.map((r) => [r.id, r]));
      expect(byId.program).toMatchObject({ status: "failed", failure: "regressed-check" });
      expect(byId.docs!.failure).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("an earlier check superseded by this call's check naming the same criteria is not re-run (issue #106 review)", async () => {
    const root = mkdtempSync(join(tmpdir(), "regression-gate-superseded-"));
    const dir = join(root, "work");
    try {
      mkdirSync(dir);
      const m = milestone(dir);
      await m.round(V1, [{ ...ZERO_PRICE, criteria: ["c1"] }], review("needs-changes", "the summary line is missing"));
      m.ran.length = 0;
      // The director replaced the zero-price check with another one for the same criterion.
      const fix = await m.round(V2_BROKEN, [{ ...OTHER, criteria: ["c1"] }], review("accept"));
      expect(m.ran).not.toContain("zero-price");
      expect(fix.failure).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
