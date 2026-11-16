import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FanoutScopeRegistry } from "../../approval/fanout-scope.js";
import type { RunTurnResult } from "../../agent/agent-loop.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { FUSION_WORKER_ID_PREFIX } from "../../session/fusion-worker-session.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import {
  buildAcceptanceChecklist,
  gatherEvidence,
  JUDGE_DIFF_FILE_CHARS,
  JUDGE_FILE_CHARS,
  judgeTask,
  parseJudgeAnswer,
  renderJudgePrompt,
  renderRetryFindings,
  RETRY_OUTPUT_CHARS,
  type AcceptanceItem,
} from "./judge.js";
import {
  buildFusionDelegateTool,
  type FusionDelegateDeps,
} from "./fusion-delegate.js";
import type { EscalationComplete } from "./escalation.js";
import type { FusionTeamContext } from "./team-routing.js";
import type { DelegateTask } from "./delegate-args.js";

const logger = new StructuredLogger({ level: "error", sinks: [] });
const TARGET = { providerId: "cloud", model: "judge-model" };

type Issue = { item: string | null; severity: "blocker" | "major" | "minor"; file: string | null; why: string };
/** A reviewer's answer in the strict schema (issue #38). */
const reviewJson = (decision: "accept" | "needs-changes", issues: Issue[] = []): string =>
  JSON.stringify({ decision, issues });
const reject = (item: string, why: string): string =>
  reviewJson("needs-changes", [{ item, severity: "blocker", file: null, why }]);
const ACCEPT = reviewJson("accept");

function answer(content: string): EscalationComplete {
  return async () => ({ content });
}

describe("acceptance checklist (ATO-944)", () => {
  it("lists the task's checks, provides, files, deliverable and instructions", () => {
    const task: DelegateTask = {
      id: "ui",
      title: "UI",
      instructions: "Build the HUD",
      deliverable: "a HUD showing score",
      files: ["hud.js"],
    };
    const items = buildAcceptanceChecklist(task, {
      checks: [{ task: "ui", command: "node test.js" }, { task: "other", command: "x" }],
      provides: [{ task: "ui", kind: "symbol", name: "HUD.draw", in: "hud.js", shape: "(ctx) => void" }],
    });
    expect(items.map((i) => i.kind)).toEqual([
      "check",
      "provide",
      "file",
      "deliverable",
      "instructions",
    ]);
    expect(items[0]!.checkIndex).toBe(0);
    expect(items[1]!.judged).toBe(true);
  });
});

describe("the judge cannot pass what the facts fail", () => {
  const dir = mkdtempSync(join(tmpdir(), "judge-"));
  const task: DelegateTask = { id: "t", title: "T", instructions: "write a.txt", files: ["a.txt"] };
  const items = buildAcceptanceChecklist(task, undefined);

  it("keeps a missing file red and does not pay the judge for it", async () => {
    let called = 0;
    const verdict = await judgeTask({
      task,
      items,
      facts: { checkOutcomes: [], findings: [] },
      reply: "Done! I wrote a.txt.",
      contract: undefined,
      workingDir: dir,
      target: TARGET,
      pricing: undefined,
      complete: async () => {
        called += 1;
        return { content: ACCEPT };
      },
      signal: new AbortController().signal,
    });
    expect(called).toBe(0);
    expect(verdict.green).toBe(false);
    expect(verdict.items.find((v) => v.id === "a1")).toMatchObject({ pass: false, why: "missing" });
  });

  it("reads a needs-changes issue as its item red, and an item no issue names as met", async () => {
    writeFileSync(join(dir, "a.txt"), "hello");
    const both: AcceptanceItem[] = [
      ...items,
      { id: "a3", kind: "deliverable", text: "x", judged: true },
    ];
    const verdict = await judgeTask({
      task,
      items: both,
      facts: { checkOutcomes: [], findings: [] },
      reply: "",
      contract: undefined,
      workingDir: dir,
      target: TARGET,
      pricing: undefined,
      complete: answer(reviewJson("needs-changes", [{ item: "a3", severity: "major", file: "a.txt", why: "no score" }])),
      signal: new AbortController().signal,
    });
    expect(verdict.green).toBe(false);
    expect(verdict.items.find((v) => v.id === "a2")?.pass).toBe(true);
    expect(verdict.items.find((v) => v.id === "a3")).toMatchObject({ pass: false, why: "no score", by: "judge" });
    expect(verdict.review).toEqual({
      decision: "needs-changes",
      issues: [{ item: "a3", severity: "major", file: "a.txt", why: "no score", by: "reviewer" }],
      reviewer: "judge-model",
    });
  });

  it("leaves a task unverified, never green, when the answer cannot be read", async () => {
    const verdict = await judgeTask({
      task,
      items,
      facts: { checkOutcomes: [], findings: [] },
      reply: "",
      contract: undefined,
      workingDir: dir,
      target: TARGET,
      pricing: undefined,
      complete: async () => ({ content: "Looks great to me!" }),
      signal: new AbortController().signal,
    });
    expect(verdict.green).toBe(false);
    expect(verdict.unverified).toMatch(/could not be read/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("parses a JSON answer wrapped in prose", () => {
    const parsed = parseJudgeAnswer(`Here: ${reviewJson("accept", [{ item: "a1", severity: "minor", file: null, why: "nit" }])} done`);
    expect(parsed).toEqual({ ok: true, decision: "accept", issues: [{ item: "a1", severity: "minor", file: null, why: "nit" }] });
  });
});

describe("the structured review verdict (issue #38)", () => {
  const issue = (over: Partial<Issue> = {}): Issue => ({ item: "a1", severity: "blocker", file: null, why: "wrong", ...over });

  it.each([
    ["not JSON", "Looks great to me!"],
    ["an unknown decision", JSON.stringify({ decision: "maybe", issues: [] })],
    ["a missing issues list", JSON.stringify({ decision: "accept" })],
    ["an extra top-level key", JSON.stringify({ decision: "accept", issues: [], items: [] })],
    ["an extra issue key", JSON.stringify({ decision: "needs-changes", issues: [{ ...issue(), line: 3 }] })],
    ["an issue without file", JSON.stringify({ decision: "needs-changes", issues: [{ item: "a1", severity: "major", why: "x" }] })],
    ["an unknown severity", reviewJson("needs-changes", [issue({ severity: "critical" as never })])],
    ["a numeric item", JSON.stringify({ decision: "needs-changes", issues: [{ ...issue(), item: 1 }] })],
    ["an empty why", reviewJson("needs-changes", [issue({ why: "  " })])],
    ["a why over 200 chars", reviewJson("needs-changes", [issue({ why: "w".repeat(201) })])],
    ["a file over 200 chars", reviewJson("needs-changes", [issue({ file: "f".repeat(201) })])],
    ["an item over 200 chars", reviewJson("needs-changes", [issue({ item: "i".repeat(201) })])],
    ["more than 20 issues", reviewJson("needs-changes", Array.from({ length: 21 }, () => issue()))],
    ["needs-changes without an issue", reviewJson("needs-changes")],
  ])("refuses %s, without repair", (_what, content) => {
    expect(parseJudgeAnswer(content).ok).toBe(false);
  });

  it("accepts the full schema at its bounds", () => {
    const issues = Array.from({ length: 20 }, (_, i) => issue({ item: i % 2 === 0 ? null : "a1", file: i % 3 === 0 ? "src/a.ts" : null, why: "w".repeat(200) }));
    issues[1] = issue({ item: "i".repeat(200), file: "f".repeat(200), why: "w".repeat(200) });
    expect(parseJudgeAnswer(reviewJson("needs-changes", issues))).toEqual({ ok: true, decision: "needs-changes", issues });
  });

  const dir = mkdtempSync(join(tmpdir(), "judge-rv-"));
  writeFileSync(join(dir, "a.txt"), "hello");
  const task: DelegateTask = { id: "t", title: "T", instructions: "write a.txt", files: ["a.txt"] };
  const items = buildAcceptanceChecklist(task, undefined);
  const judge = (content: string, target: typeof TARGET & { pinModel?: string } = TARGET, workingDir = dir) =>
    judgeTask({
      task,
      items,
      facts: { checkOutcomes: [], findings: [] },
      reply: "",
      contract: undefined,
      workingDir,
      target,
      pricing: undefined,
      complete: answer(content),
      signal: new AbortController().signal,
    });

  it("turns an accept with a blocker or major issue into needs-changes", async () => {
    for (const severity of ["blocker", "major"] as const) {
      const verdict = await judge(reviewJson("accept", [issue({ item: "a2", severity, why: "half done" })]));
      expect(verdict.green).toBe(false);
      expect(verdict.review.decision).toBe("needs-changes");
      expect(verdict.items.find((v) => v.id === "a2")).toMatchObject({ pass: false, why: "half done" });
    }
  });

  it("closes a minor-only review as accept and keeps the minors listed, whatever decision it named", async () => {
    for (const decision of ["accept", "needs-changes"] as const) {
      const verdict = await judge(reviewJson(decision, [issue({ item: "a2", severity: "minor", file: "a.txt", why: "rename x" })]));
      expect(verdict.green).toBe(true);
      expect(verdict.unverified).toBeUndefined();
      expect(verdict.review).toEqual({
        decision: "accept",
        issues: [{ item: "a2", severity: "minor", file: "a.txt", why: "rename x", by: "reviewer" }],
        reviewer: "judge-model",
      });
      expect(verdict.items.every((v) => v.pass)).toBe(true);
    }
  });

  it("puts an issue that names no judged item on the instructions item, so the list is red", async () => {
    const verdict = await judge(reviewJson("needs-changes", [issue({ item: null, why: "breaks the build" }), issue({ item: "a1", why: "too short" })]));
    expect(verdict.green).toBe(false);
    // a1 is a fact (the file exists): the reviewer does not change it.
    expect(verdict.items.find((v) => v.id === "a1")).toMatchObject({ pass: true, by: "fact" });
    expect(verdict.items.find((v) => v.id === "a2")).toMatchObject({ pass: false, by: "judge" });
    expect(verdict.items.find((v) => v.id === "a2")?.why).toContain("breaks the build");
    expect(verdict.items.find((v) => v.id === "a2")?.why).toContain("too short");
    expect(verdict.review.issues.map((i) => i.item)).toEqual([null, "a1"]);
  });

  it("leaves a malformed answer unverified, naming the reviewer that was asked", async () => {
    const verdict = await judge(JSON.stringify({ items: [{ id: "a2", pass: true }] }), { ...TARGET, pinModel: "model-r" });
    expect(verdict.green).toBe(false);
    expect(verdict.unverified).toMatch(/could not be read/);
    expect(verdict.review).toEqual({ decision: "unverified", issues: [], reviewer: "model-r" });
  });

  it("makes red facts blocker issues by fact, without asking the reviewer", async () => {
    const empty = mkdtempSync(join(tmpdir(), "judge-rv-"));
    let called = 0;
    const verdict = await judgeTask({
      task,
      items,
      facts: { checkOutcomes: [], findings: [] },
      reply: "",
      contract: undefined,
      workingDir: empty,
      target: TARGET,
      pricing: undefined,
      complete: async () => {
        called += 1;
        return { content: ACCEPT };
      },
      signal: new AbortController().signal,
    });
    expect(called).toBe(0);
    expect(verdict.review).toEqual({
      decision: "needs-changes",
      issues: [{ item: "a1", severity: "blocker", file: "a.txt", why: "missing", by: "fact" }],
      reviewer: null,
    });
    rmSync(empty, { recursive: true, force: true });
  });

  it("an all-green list with nothing to judge is an accept no reviewer gave", async () => {
    const verdict = await judgeTask({
      task,
      items: items.filter((i) => !i.judged),
      facts: { checkOutcomes: [], findings: [] },
      reply: "",
      contract: undefined,
      workingDir: dir,
      target: TARGET,
      pricing: undefined,
      complete: answer(ACCEPT),
      signal: new AbortController().signal,
    });
    expect(verdict.green).toBe(true);
    expect(verdict.review).toEqual({ decision: "accept", issues: [], reviewer: null });
  });

  it("asks for the new JSON shape", () => {
    const prompt = renderJudgePrompt({ task, items, facts: [], evidence: "" });
    expect(prompt).toContain('{"decision":"accept"|"needs-changes","issues":[{"item":"a2"|null,"severity":"blocker"|"major"|"minor","file":"src/a.ts"|null,"why":"…"}]}');
    expect(prompt).toMatch(/at most 20 issues/);
    // Under the issue list an item no issue names counts as met, so the
    // reviewer is asked to name every unmet one.
    expect(prompt).toMatch(/List an issue for every item that is not met/);
    expect(prompt).toMatch(/An item no issue names counts as met/);
    expect(prompt).not.toContain('"pass"');
  });
});

function mode(over: Partial<ResolvedRunMode> = {}): ResolvedRunMode {
  return {
    stored: "fusion",
    effective: "fusion",
    orchestratorProviderId: "cloud",
    orchestratorModel: "big",
    workerProviderId: "local",
    workerModel: "small",
    workers: 1,
    workersPinned: true,
    workerMaxSteps: 7,
    workerTimeoutMs: 60_000,
    primaryProviderId: "cloud",
    degraded: null,
    judge: TARGET,
    ...over,
  };
}

function deps(
  dir: string,
  complete: EscalationComplete,
  over: Partial<FusionDelegateDeps> = {},
): FusionDelegateDeps & { briefs: string[] } {
  let minted = 0;
  const d = {
    briefs: [] as string[],
    runTurn: async (_s: unknown, message: string) => {
      d.briefs.push(message);
      writeFileSync(join(dir, "a.txt"), `attempt ${d.briefs.length}`);
      return {
        session: createEmptySessionState({ id: "s-w", workingDir: dir }),
        reason: "reply",
        stepCount: 1,
      } as RunTurnResult;
    },
    createEphemeralSession: (meta: never) => {
      minted += 1;
      return createEmptySessionState({
        id: `${FUSION_WORKER_ID_PREFIX}${minted}`,
        workingDir: dir,
        metadata: { fusionWorker: { ...(meta as object) } },
      });
    },
    approvals: {
      setSessionPolicy: () => {},
      clearSessionPolicy: () => {},
      fanoutScopes: new FanoutScopeRegistry(),
    },
    approvalRequired: false,
    emitEvent: () => {},
    workingDir: dir,
    slotManager: { poolSize: () => 4 },
    resolveRunMode: () => mode(),
    workerSupportsSlotAffinity: () => false,
    warmWorkerBackend: async () => {},
    outputCharCap: 4000,
    logger,
    escalationComplete: complete,
    ...over,
  } as FusionDelegateDeps & { briefs: string[] };
  return d;
}

const TASK: DelegateTask[] = [{ id: "t", title: "T", instructions: "write a.txt with the score", files: ["a.txt"] }];

describe("a node closes only on a green list (ATO-944)", () => {
  it("puts the list in the brief, re-runs a red task once with the findings, and fails it honestly if still red", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-d-"));
    let judged = 0;
    const d = deps(dir, async () => {
      judged += 1;
      return { content: reject("a2", "no score in a.txt") };
    });
    const result = await buildFusionDelegateTool(d).run(
      { tasks: TASK },
      { workingDir: dir, sessionId: "s-p", stepIndex: 0, signal: new AbortController().signal },
    );
    expect(d.briefs).toHaveLength(2);
    expect(d.briefs[0]).toContain("ACCEPTANCE CHECKLIST (read-only)");
    expect(d.briefs[1]).toContain("[a2] the task is done as instructed: write a.txt with the score — no score in a.txt");
    expect(judged).toBe(2);
    const row = (result.details.tasks as Array<{ status: string; error?: string }>)[0]!;
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/^judge: 1 of 2 acceptance items not met after one retry — a2 no score in a\.txt/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("names the delegating session on every judge call, for its spend readout (ATO-1388)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-sid-"));
    const sessions: Array<string | undefined> = [];
    const d = deps(dir, async (call) => {
      sessions.push(call.sessionId);
      return { content: ACCEPT };
    });
    await buildFusionDelegateTool(d).run(
      { tasks: TASK },
      { workingDir: dir, sessionId: "s-p", stepIndex: 0, signal: new AbortController().signal },
    );
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((id) => id === "s-p")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("closes a task the retry fixed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-g-"));
    let judged = 0;
    const d = deps(dir, async () => {
      judged += 1;
      return { content: judged > 1 ? ACCEPT : reject("a2", "missing score") };
    });
    const result = await buildFusionDelegateTool(d).run(
      { tasks: TASK },
      { workingDir: dir, sessionId: "s-p", stepIndex: 0, signal: new AbortController().signal },
    );
    const row = (result.details.tasks as Array<{ status: string; notes?: string[] }>)[0]!;
    expect(row.status).toBe("ok");
    expect(row.notes?.join(" ")).toContain("judge: all 2 acceptance items green after one retry");
    rmSync(dir, { recursive: true, force: true });
  });

  it("lets the retry of a task with no files split it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-s-"));
    const proposal =
      "Too big.\n```split_proposal\n" +
      JSON.stringify({
        tasks: [
          { id: "a", title: "A", instructions: "research part a" },
          { id: "b", title: "B", instructions: "research part b" },
        ],
      }) +
      "\n```";
    let judged = 0;
    const briefs: string[] = [];
    const d = deps(
      dir,
      async () => {
        judged += 1;
        return { content: judged > 1 ? ACCEPT : reject("a1", "too thin") };
      },
      { resolveRunMode: () => mode({ taskTree: { maxDepth: 2, maxNodes: 24 } }) },
    );
    d.runTurn = async (_session, message, options) => {
      briefs.push(message);
      const text = message.includes("research part")
        ? "part done"
        : briefs.length === 1
          ? "thin answer"
          : proposal;
      options.eventHook?.({ type: "llm_event", event: { type: "assistant_reply", text } });
      return {
        session: createEmptySessionState({ id: "s-w", workingDir: dir }),
        reason: "reply",
        stepCount: 1,
      } as RunTurnResult;
    };
    const result = await buildFusionDelegateTool(d).run(
      { tasks: [{ id: "t", title: "T", instructions: "research the market" }] },
      { workingDir: dir, sessionId: "s-p", stepIndex: 0, signal: new AbortController().signal },
    );
    expect(briefs[1]).toContain("If this task is too big");
    expect(result.details.taskTree).toMatchObject({ splits: 1 });
    const row = (result.details.tasks as Array<{ status: string; reply: string }>)[0]!;
    expect(row.reply).toContain("[t/a] ok");
    expect(row.status).toBe("ok");
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the status of a retry that ended without being judged (stopped by the person)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-c-"));
    let runs = 0;
    const d = deps(dir, async () => ({ content: reject("a2", "no score") }));
    d.runTurn = async () => {
      runs += 1;
      writeFileSync(join(dir, "a.txt"), `attempt ${runs}`);
      return {
        session: createEmptySessionState({ id: "s-w", workingDir: dir }),
        reason: runs === 1 ? "reply" : "cancelled",
        stepCount: 1,
      } as RunTurnResult;
    };
    const result = await buildFusionDelegateTool(d).run(
      { tasks: TASK },
      { workingDir: dir, sessionId: "s-p", stepIndex: 0, signal: new AbortController().signal },
    );
    const row = (result.details.tasks as Array<{ status: string; notes?: string[] }>)[0]!;
    expect(row.status).toBe("cancelled");
    expect(row.notes?.join(" ")).toMatch(/the retry ended cancelled and was not judged/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("changes nothing when the judge is off", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-o-"));
    let judged = 0;
    const d = deps(
      dir,
      async () => {
        judged += 1;
        return { content: "{}" };
      },
      { resolveRunMode: () => mode({ judge: null }) },
    );
    const result = await buildFusionDelegateTool(d).run(
      { tasks: TASK },
      { workingDir: dir, sessionId: "s-p", stepIndex: 0, signal: new AbortController().signal },
    );
    expect(judged).toBe(0);
    expect(d.briefs).toHaveLength(1);
    expect(d.briefs[0]).not.toContain("ACCEPTANCE CHECKLIST");
    expect((result.details.tasks as Array<{ status: string }>)[0]!.status).toBe("ok");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the retry brief carries a failing check's output", () => {
  it("quotes the output tail under the red check item, bounded", () => {
    const items: AcceptanceItem[] = [
      { id: "a1", kind: "check", text: "the check passes: {\"cmd\":\"npm test\"}", checkIndex: 0, judged: false },
    ];
    const text = renderRetryFindings(items, {
      green: false,
      costUsd: null,
      review: { decision: "needs-changes", issues: [], reviewer: null },
      items: [
        {
          id: "a1",
          pass: false,
          why: "verify.run command: FAILED exit 1 after 9 ms",
          by: "fact",
          output: `${"z".repeat(5000)}\nAssertionError: expected 3 to equal 4`,
        },
      ],
    });
    expect(text).toContain("[a1] the check passes");
    expect(text).toContain("  output:\n");
    expect(text).toContain("    AssertionError: expected 3 to equal 4");
    expect((text.match(/z/g) ?? []).length).toBeLessThanOrEqual(RETRY_OUTPUT_CHARS);
  });

  it("reaches the retried worker's brief from a real failing check", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-out-"));
    const d = deps(dir, answer(ACCEPT), {
      runChecks: async () => ({
        ok: false,
        results: [
          {
            ok: false,
            summary: "verify.run command: FAILED\nexit 1 after 5 ms\nstderr (tail):\nError: score is NaN\n    at hud.js:3:9",
            stderrTail: "Error: score is NaN\n    at hud.js:3:9",
          },
        ],
      }),
    });
    await buildFusionDelegateTool(d).run(
      {
        tasks: TASK,
        contract: { checks: [{ task: "t", kind: "command", cmd: "node hud.js" }] },
      },
      { workingDir: dir, sessionId: "s-p", stepIndex: 0, signal: new AbortController().signal },
    );
    const retry = d.briefs.find((b) => b.includes("A judge found these acceptance items NOT met"));
    expect(retry).toBeDefined();
    expect(retry).toContain("    Error: score is NaN\n        at hud.js:3:9");
    rmSync(dir, { recursive: true, force: true });
  });

  it("masks a secret in the check output before the retry brief quotes it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-mask-"));
    const d = deps(dir, answer(ACCEPT), {
      runChecks: async () => ({
        ok: false,
        results: [
          {
            ok: false,
            summary: "verify.run command: FAILED\nexit 1 after 5 ms",
            stderrTail: "Error: auth failed for sk_live_abcdefghijklmnop1234 at db.js:3:9",
          },
        ],
      }),
    });
    await buildFusionDelegateTool(d).run(
      {
        tasks: TASK,
        contract: { checks: [{ task: "t", kind: "command", cmd: "node db.js" }] },
      },
      { workingDir: dir, sessionId: "s-p", stepIndex: 0, signal: new AbortController().signal },
    );
    const retry = d.briefs.find((b) => b.includes("A judge found these acceptance items NOT met"));
    expect(retry).toBeDefined();
    expect(retry).toContain("Error: auth failed for [redacted:stripe-key] at db.js:3:9");
    expect(retry).not.toContain("sk_live_abcdefghijklmnop1234");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("judge evidence", () => {
  const task: DelegateTask = { id: "t", title: "T", instructions: "edit a.txt", files: ["a.txt"] };

  it("without a diff (no isolation) reads each declared file's head, as before", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-ev-"));
    writeFileSync(join(dir, "a.txt"), "x".repeat(JUDGE_FILE_CHARS + 50));
    const evidence = await gatherEvidence(task, undefined, "", dir);
    expect(evidence.startsWith("### a.txt\n")).toBe(true);
    expect(evidence).toContain("[… 50 more chars clipped]");
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the diff when the changes are known, shows an unchanged declared file's head, and masks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-ev-"));
    writeFileSync(join(dir, "a.txt"), "kept\n");
    const secret = "sk-test-" + "Z".repeat(32);
    const evidence = await gatherEvidence(
      { ...task, files: ["a.txt", "b.txt"] },
      undefined,
      "",
      dir,
      [
        {
          path: "b.txt",
          kind: "modified",
          patch: `--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-old\n+key=${secret}\n`,
        },
      ],
      [{ label: "TEST_KEY", value: secret }],
    );
    expect(evidence).toContain("Touched files: b.txt (modified)");
    expect(evidence).toContain("Declared but not changed: a.txt");
    expect(evidence).toContain("### a.txt (unchanged)\nkept");
    expect(evidence).toContain("-old");
    expect(evidence).not.toContain(secret);
    rmSync(dir, { recursive: true, force: true });
  });

  it("masks a secret the clip would cut in half: masked first, then clipped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-ev-"));
    const secret = "Kx9qWmTr4vLp8nZs2bYc7hJd3fGa";
    const known = [{ label: "TEST_KEY", value: secret }];
    // The secret starts just before the per-file diff cap and the file-head cap.
    const header = "--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n+";
    const pad = "p".repeat(JUDGE_DIFF_FILE_CHARS - header.length - 10);
    const diff = await gatherEvidence(
      { ...task, files: ["b.txt"] },
      undefined,
      "",
      dir,
      [{ path: "b.txt", kind: "modified", patch: `${header}${pad}${secret}\n` }],
      known,
    );
    expect(diff).not.toContain(secret.slice(0, 8));
    const added = await gatherEvidence(
      { ...task, files: ["c.txt"] },
      undefined,
      "",
      dir,
      [
        {
          path: "c.txt",
          kind: "added",
          patch: "--- /dev/null\n+++ b/c.txt\n",
          content: `${"c".repeat(JUDGE_FILE_CHARS - 10)}${secret}\n`,
        },
      ],
      known,
    );
    expect(added).not.toContain(secret.slice(0, 8));
    writeFileSync(join(dir, "a.txt"), `${"a".repeat(JUDGE_FILE_CHARS - 10)}${secret}\n`);
    const heads = await gatherEvidence(task, undefined, "", dir, undefined, known);
    expect(heads).not.toContain(secret.slice(0, 8));
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the judge from the fusion team's reviewers (issue #37)", () => {
  const families: Record<string, "anthropic" | "openai" | "local"> = { "api-a": "anthropic", "cli-b": "openai", local: "local" };
  const team = (over: Partial<FusionTeamContext["team"]> = {}): FusionTeamContext => ({
    team: { directors: ["api-a:model-a"], workers: ["local:small", "cli-b:model-b"], reviewers: ["cli-b:model-r", "api-a:model-o"], ...over },
    fusion: { workerProvider: "local" },
    familyOf: (m) => families[m.providerId] ?? "other",
    reachable: () => true,
    pinsModel: (id) => id !== "local",
  });
  const green = { content: ACCEPT };
  const run = async (context: FusionTeamContext | undefined, task = TASK, over: Partial<ResolvedRunMode> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "judge-team-"));
    const calls: Array<{ providerId: string; model: string | undefined }> = [];
    const priced: string[] = [];
    const d = deps(dir, async (call) => {
      calls.push({ providerId: call.providerId, model: call.model });
      return green;
    }, {
      resolveRunMode: () => mode(over),
      resolveFusionTeam: () => context,
      resolveWorkerPricing: (providerId, model) => {
        priced.push(`${providerId}:${model}`);
        return undefined;
      },
    });
    const result = await buildFusionDelegateTool(d).run(
      { tasks: task },
      { workingDir: dir, sessionId: "s-p", stepIndex: 0, signal: new AbortController().signal },
    );
    rmSync(dir, { recursive: true, force: true });
    return { calls, priced, result, briefs: d.briefs };
  };

  it("asks the first reachable reviewer of another family than the worker, on its own model", async () => {
    const local = await run(team());
    expect(local.calls).toEqual([{ providerId: "cli-b", model: "model-r" }]);
    expect(local.priced).toContain("cli-b:model-r");
    const onCli = await run(team(), [{ ...TASK[0]!, model: "cli-b:model-b" }]);
    expect(onCli.calls).toEqual([{ providerId: "api-a", model: "model-o" }]);
  });

  it("names every distinct reviewer that ruled on the spend line, not only the first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-spend-"));
    writeFileSync(join(dir, "b.txt"), "b");
    const d = deps(dir, async () => ({
      content: ACCEPT,
      usage: { promptTokens: 1_000, completionTokens: 200, totalTokens: 1_200, costUsd: 0.01 },
    }), { resolveFusionTeam: () => team() });
    const result = await buildFusionDelegateTool(d).run(
      {
        tasks: [
          { id: "t", title: "T", instructions: "write a.txt", files: ["a.txt"] },
          { id: "u", title: "U", instructions: "read b.txt", model: "cli-b:model-b" },
        ],
      },
      { workingDir: dir, sessionId: "s-spend", stepIndex: 0, signal: new AbortController().signal },
    );
    rmSync(dir, { recursive: true, force: true });
    expect(result.summary).toMatch(/The judges \(model-r, model-o\) cost \$0\.02/);
  });

  it("with crossFamilyReview off asks the first reachable reviewer", async () => {
    const onCli = await run(team({ crossFamilyReview: false }), [{ ...TASK[0]!, model: "cli-b:model-b" }]);
    expect(onCli.calls).toEqual([{ providerId: "cli-b", model: "model-r" }]);
  });

  it("falls back to judgeProvider when no reviewer fits, only while the judge is on", async () => {
    const none = await run(team({ reviewers: ["local:other"] }));
    expect(none.calls).toEqual([{ providerId: TARGET.providerId, model: undefined }]);
    // No fitting reviewer and the judge off: no model reviews the task.
    const off = await run(team({ reviewers: ["local:other"] }), TASK, { judge: null });
    expect(off.calls).toEqual([]);
    expect(off.briefs[0]).not.toContain("ACCEPTANCE CHECKLIST");
  });

  it("listed reviewers turn review on with the judge off; team.review decides when set (issue #38)", async () => {
    const reviewerOnly = await run(team(), TASK, { judge: null });
    expect(reviewerOnly.calls).toEqual([{ providerId: "cli-b", model: "model-r" }]);
    expect(reviewerOnly.briefs[0]).toContain("ACCEPTANCE CHECKLIST");
    const off = await run(team({ review: "off" }));
    expect(off.calls).toEqual([]);
    expect(off.briefs[0]).not.toContain("ACCEPTANCE CHECKLIST");
    // `review: "on"` with no reviewer listed: judgeProvider, as the judge is on.
    const on = await run(team({ reviewers: [], review: "on" }), TASK);
    expect(on.calls).toEqual([{ providerId: TARGET.providerId, model: undefined }]);
  });

  it("asks a stronger reviewer of the worker's family before a weaker one of another (issue #38)", async () => {
    const tiers: Record<string, "cheap" | "balanced" | "best"> = {
      "cli-b:model-b": "balanced", "cli-b:model-r": "best", "api-a:model-o": "cheap",
    };
    const onCli = await run({ ...team(), strength: (m) => tiers[m.ref] ?? null }, [{ ...TASK[0]!, model: "cli-b:model-b" }]);
    expect(onCli.calls).toEqual([{ providerId: "cli-b", model: "model-r" }]);
  });

  it("without a team judges on judgeProvider as before", async () => {
    const before = await run(undefined);
    expect(before.calls).toEqual([{ providerId: TARGET.providerId, model: undefined }]);
  });
});

describe("review passes with a fusion team (issue #38)", () => {
  const families: Record<string, "anthropic" | "openai" | "local"> = { "api-a": "anthropic", "cli-b": "openai", local: "local" };
  const team = (over: Partial<FusionTeamContext["team"]> = {}): FusionTeamContext => ({
    team: { directors: ["api-a:model-a"], workers: ["local:small"], reviewers: ["cli-b:model-r"], ...over },
    fusion: { workerProvider: "local" },
    familyOf: (m) => families[m.providerId] ?? "other",
    reachable: () => true,
    pinsModel: (id) => id !== "local",
  });
  const blocker = reviewJson("needs-changes", [{ item: "a2", severity: "blocker", file: "a.txt", why: "no score" }]);
  type Row = {
    status: string;
    error?: string;
    notes?: string[];
    failure?: string;
    judge?: { passes?: number; retried: boolean; review?: { decision: string } };
  };
  const run = async (
    context: FusionTeamContext | undefined,
    answers: (n: number, signal: AbortController) => string,
    over: Partial<FusionDelegateDeps> = {},
    runOver: Partial<ResolvedRunMode> = {},
  ) => {
    const dir = mkdtempSync(join(tmpdir(), "judge-pass-"));
    const abort = new AbortController();
    let judged = 0;
    const d = deps(dir, async () => {
      judged += 1;
      return { content: answers(judged, abort) };
    }, { resolveRunMode: () => mode(runOver), resolveFusionTeam: () => context, ...over });
    const result = await buildFusionDelegateTool(d).run(
      { tasks: TASK },
      { workingDir: dir, sessionId: "s-pass", stepIndex: 0, signal: abort.signal },
    );
    rmSync(dir, { recursive: true, force: true });
    return { result, briefs: d.briefs, judged: () => judged, row: (result.details.tasks as Row[])[0]! };
  };

  it("re-runs a task the review sends back up to reviewPasses times (default 2)", async () => {
    const { briefs, judged, row } = await run(team(), () => blocker);
    expect(briefs).toHaveLength(3);
    expect(judged()).toBe(3);
    expect(row.judge?.passes).toBe(2);
    expect(row.error).toMatch(/after 2 review passes/);
    const one = await run(team({ reviewPasses: 1 }), () => blocker);
    expect(one.briefs).toHaveLength(2);
    const none = await run(team({ reviewPasses: 0 }), () => blocker);
    expect(none.briefs).toHaveLength(1);
  });

  it("briefs each pass with the remaining issues, severity and file", async () => {
    const { briefs } = await run(team(), (n) =>
      n === 1
        ? reviewJson("needs-changes", [
            { item: "a2", severity: "blocker", file: "a.txt", why: "no score" },
            { item: null, severity: "minor", file: null, why: "terse" },
          ])
        : reviewJson("needs-changes", [{ item: "a2", severity: "major", file: "a.txt", why: "score wrong" }]),
    );
    expect(briefs[1]).toContain("- blocker a.txt [a2]: no score");
    expect(briefs[1]).toContain("- minor: terse");
    expect(briefs[2]).toContain("- major a.txt [a2]: score wrong");
    expect(briefs[2]).not.toContain("no score");
  });

  it("closes a task a later pass fixed", async () => {
    const { briefs, row } = await run(team(), (n) => (n < 3 ? blocker : ACCEPT));
    expect(briefs).toHaveLength(3);
    expect(row.status).toBe("ok");
    expect(row.notes?.join(" ")).toContain("green after 2 review passes");
  });

  it("does not pass a minor-only accept again", async () => {
    const { briefs, row } = await run(team(), () =>
      reviewJson("accept", [{ item: "a2", severity: "minor", file: "a.txt", why: "naming" }]),
    );
    expect(briefs).toHaveLength(1);
    expect(row.status).toBe("ok");
    expect(row.judge?.passes).toBe(0);
  });

  it("stops before a pass the turn budget no longer allows, keeping the last verdict", async () => {
    let spent = 0;
    const { briefs, row } = await run(
      team(),
      (n) => {
        if (n === 2) spent = 10;
        return blocker;
      },
      { orchestratorTurnSpendUsd: () => spent },
      { turnBudgetUsd: 5 },
    );
    expect(briefs).toHaveLength(2);
    expect(row.judge?.passes).toBe(1);
    expect(row.notes?.join(" ")).toMatch(/review stopped: .*budget/i);
    expect(row.failure).toBeUndefined();
  });

  it("stops before a pass once the turn is cancelled", async () => {
    const { briefs, row } = await run(team(), (n, abort) => {
      if (n === 2) abort.abort();
      return blocker;
    });
    expect(briefs).toHaveLength(2);
    expect(row.notes?.join(" ")).toContain("review stopped: the turn was cancelled");
  });

  it("records the review in the outcome log: counts, passes and reviewer, never issue text", async () => {
    const written: Array<Record<string, unknown>> = [];
    const outcomeLog = { append: (records: readonly unknown[]) => { written.push(...(records as Array<Record<string, unknown>>)); } };
    await run(team(), () => blocker, { outcomeLog });
    const task = written.find((r) => r.type === "task")!;
    expect(task.review).toEqual({ decision: "needs-changes", passes: 2, reviewer: "model-r", blockers: 1, majors: 0, minors: 0 });
    expect(task.judgeRetried).toBe(true);
    expect(task.failure).toBe("review-exhausted");
    expect(JSON.stringify(written)).not.toContain("no score");
    // Without a team the judge's review is recorded too, its one retry a pass.
    written.length = 0;
    await run(undefined, () => blocker, { outcomeLog });
    expect(written.find((r) => r.type === "task")!.review).toMatchObject({ decision: "needs-changes", passes: 1 });
    // No review ran: no field.
    written.length = 0;
    await run(undefined, () => blocker, { outcomeLog }, { judge: null });
    expect(written.find((r) => r.type === "task")!).not.toHaveProperty("review");
  });

  it.each([
    ["a team without reviewers", { reviewers: [] }],
    ["a team with no fitting reviewer", { reviewers: ["local:small"] }],
  ])("with %s keeps the judgeProvider's one retry, wording and no review-exhausted", async (_what, over) => {
    const { result, briefs, row } = await run(team(over), () => blocker, {}, { autoReplan: 2 });
    expect(briefs).toHaveLength(2);
    expect(briefs[1]).not.toContain("Remaining review issues");
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/^judge: 1 of 2 acceptance items not met after one retry/);
    expect(row.judge?.passes).toBeUndefined();
    expect(row.failure).toBeUndefined();
    expect(result.details.review).toBeUndefined();
    expect(result.summary).not.toContain("review: ");
    const replan = result.details.replan as { pending: Array<{ id: string }>; reviewExhausted: unknown[] };
    expect(replan.pending.map((t) => t.id)).toEqual(["t"]);
    expect(replan.reviewExhausted).toEqual([]);
  });

  it("without a team keeps the judge's one retry and its wording", async () => {
    const { briefs, row } = await run(undefined, () => blocker);
    expect(briefs).toHaveLength(2);
    expect(briefs[1]).not.toContain("Remaining review issues");
    expect(row.error).toMatch(/^judge: 1 of 2 acceptance items not met after one retry/);
    expect(row.judge?.passes).toBeUndefined();
    expect(row.failure).toBeUndefined();
  });
});

describe("review exhausted: the director decides (issue #38)", () => {
  const team: FusionTeamContext = {
    team: { directors: ["api-a:model-a"], workers: ["local:small"], reviewers: ["cli-b:model-r"] },
    fusion: { workerProvider: "local" },
    familyOf: (m) => (m.providerId === "local" ? "local" : "openai"),
    reachable: () => true,
    pinsModel: (id) => id !== "local",
  };
  const run = async (content: string, runOver: Partial<ResolvedRunMode> = {}, context: FusionTeamContext | null = team) => {
    const dir = mkdtempSync(join(tmpdir(), "judge-ex-"));
    const d = deps(dir, answer(content), {
      resolveRunMode: () => mode({ autoReplan: 2, ...runOver }),
      resolveFusionTeam: () => context ?? undefined,
    });
    const result = await buildFusionDelegateTool(d).run(
      { tasks: TASK },
      { workingDir: dir, sessionId: "s-ex", stepIndex: 0, signal: new AbortController().signal },
    );
    rmSync(dir, { recursive: true, force: true });
    return { result, briefs: d.briefs, row: (result.details.tasks as Array<{ status: string; failure?: string; error?: string }>)[0]! };
  };
  const blocker = reviewJson("needs-changes", [{ item: "a2", severity: "blocker", file: "a.txt", why: "no score" }]);

  it("fails a task still sent back after the last pass as review-exhausted, for the director, not as pending", async () => {
    const { result, briefs, row } = await run(blocker);
    expect(briefs).toHaveLength(3);
    expect(row.status).toBe("failed");
    expect(row.failure).toBe("review-exhausted");
    expect(row.error).toMatch(/^review-exhausted: needs-changes after 2 review passes/);
    const replan = result.details.replan as { pending: unknown[]; reviewExhausted: Array<{ id: string }> };
    expect(replan.pending).toEqual([]);
    expect(replan.reviewExhausted.map((t) => t.id)).toEqual(["t"]);
    expect(result.summary).toContain("REVIEW PASSES USED");
  });

  it("hands the director the review-exhausted task with autoReplan off too, without the re-delegate option", async () => {
    const { result, row } = await run(blocker, { autoReplan: 0 });
    expect(row.failure).toBe("review-exhausted");
    const replan = result.details.replan as { pending: unknown[]; exhausted: unknown[]; reviewExhausted: Array<{ id: string; redelegate?: false }> };
    expect(replan.pending).toEqual([]);
    expect(replan.exhausted).toEqual([]);
    expect(replan.reviewExhausted).toEqual([expect.objectContaining({ id: "t", redelegate: false })]);
    expect(result.summary).toContain("REVIEW PASSES USED");
    expect(result.summary).not.toContain("NO REPLANS LEFT");
    expect(result.summary).not.toMatch(/re-delegate it/);
  });

  it("an answer that cannot be read is unverified for the orchestrator, never review-exhausted", async () => {
    const { result, row } = await run("not json");
    expect(row.status).toBe("needs_orchestrator");
    expect(row.failure).toBeUndefined();
    expect(row.error ?? "").not.toMatch(/review-exhausted/);
    const replan = result.details.replan as { pending: Array<{ id: string }>; reviewExhausted: unknown[] };
    expect(replan.reviewExhausted).toEqual([]);
    expect(replan.pending.map((t) => t.id)).toEqual(["t"]);
  });

  it("shows the director a review clause and the full review in details.review (issue #38)", async () => {
    const { result } = await run(blocker);
    expect(result.summary).toMatch(/review: needs-changes after 2 passes \(model-r\) — 1 blocker a\.txt: no score/);
    expect((result.details.review as Record<string, unknown>).t).toEqual({
      decision: "needs-changes",
      passes: 2,
      reviewer: "model-r",
      issues: [{ item: "a2", severity: "blocker", file: "a.txt", why: "no score", by: "reviewer" }],
    });
  });

  it("without a team the still-red task fails as before, and is pending for the replan", async () => {
    const { result, row } = await run(blocker, {}, null);
    expect(row.failure).toBeUndefined();
    expect(result.details.review).toBeUndefined();
    expect(result.summary).not.toContain("review: ");
    expect((result.details.replan as { pending: Array<{ id: string }> }).pending.map((t) => t.id)).toEqual(["t"]);
  });
});
