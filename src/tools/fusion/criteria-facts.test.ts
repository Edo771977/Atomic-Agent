import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { receiptHash } from "../../session/receipt-signing.js";
import type { ContractCheckOutcome } from "./contract-checks.js";
import type { DelegateContract } from "./contract.js";
import type { DelegateTask } from "./delegate-args.js";
import { criteriaFactsFor, taskCriteria, type VisionCriterionVerdict } from "./criteria-facts.js";
import { applyJudgeVerdict, buildAcceptanceChecklist, judgeTask } from "./judge.js";
import type { WorkerTaskResult } from "./worker-result.js";

const CRITERIA = new Map([
  ["c1", { id: "c1", text: "the CLI prints the board" }],
  ["c2", { id: "c2", text: "the board looks like a chess board" }],
  ["c3", { id: "c3", text: "games end with varied winners" }],
]);
const task: DelegateTask = { id: "ui", title: "UI", instructions: "build the game", files: ["a.txt"] };
const contract: DelegateContract = {
  checks: [
    { task: "ui", criteria: ["c1"], kind: "command", cmd: "node", args: ["cli.js"] },
    { task: "ui", criteria: ["c1", "c2"], judge: "vision", kind: "page", path: "index.html", screenshot: {} },
    { task: "other", criteria: ["c3"], kind: "command", cmd: "x" },
  ],
};
const shot = { path: "/state/fusion-runs/fr-1/shots/ui-1.jpg", bytes: 10, width: 1280, height: 720 };
const green = (over: Partial<ContractCheckOutcome> = {}): ContractCheckOutcome => ({ task: "ui", ok: true, detail: "passed", ...over });
const ACCEPT = JSON.stringify({ decision: "accept", issues: [] });
const dir = mkdtempSync(join(tmpdir(), "criteria-facts-"));
writeFileSync(join(dir, "a.txt"), "x");

async function judge(outcomes: (ContractCheckOutcome | undefined)[], vision?: Map<string, VisionCriterionVerdict>, c: DelegateContract = contract) {
  let called = 0;
  const items = buildAcceptanceChecklist(task, c, CRITERIA);
  const verdict = await judgeTask({
    task, items, facts: { checkOutcomes: outcomes, findings: [], ...(vision === undefined ? {} : { vision }) },
    reply: "", contract: c, workingDir: dir, target: { providerId: "cloud", model: "model-a" }, pricing: undefined,
    complete: async () => { called += 1; return { content: ACCEPT }; },
    signal: new AbortController().signal,
  });
  return { verdict, called, items };
}

describe("criteria facts (issue #40)", () => {
  it("maps the criteria a task's checks name, in first-mention order, texts from the brief", () => {
    expect(taskCriteria("ui", contract, CRITERIA)).toEqual([
      { id: "c1", text: "the CLI prints the board", checkIndexes: [0, 1] },
      { id: "c2", text: "the board looks like a chess board", checkIndexes: [1] },
    ]);
    const items = buildAcceptanceChecklist(task, contract, CRITERIA);
    expect(items.filter((i) => i.kind === "criterion").map((i) => i.criterion?.id)).toEqual(["c1", "c2"]);
    // Without a brief no criterion items are listed.
    expect(buildAcceptanceChecklist(task, contract).some((i) => i.kind === "criterion")).toBe(false);
  });

  it("attributes non-passed results only to the decisive evidence", () => {
    const criteria = taskCriteria("ui", contract, CRITERIA);
    const visual = green({ judge: "vision", screenshots: [shot] });
    const vision = new Map([["c1", { state: "passed" as const, why: "ok", model: "cloud:vision" }]]);
    expect(criteriaFactsFor(criteria, contract, [green(), visual], undefined)[0]).toMatchObject({ state: "unverified" });
    expect(criteriaFactsFor(criteria, contract, [green(), visual], undefined)[0]?.basis).toBeUndefined();
    expect(criteriaFactsFor(criteria, contract, [green({ ok: false, detail: "exit 1" }), visual], vision)[0]).toMatchObject({
      state: "failed", why: "check 1 failed: exit 1", basis: { kind: "check", checks: [{ index: 1 }] },
    });
    const [unreliable] = criteriaFactsFor(criteria, contract, [green({ unreliable: "negative passed" }), visual], vision);
    expect(unreliable?.state).toBe("unverified");
    expect(unreliable?.basis).toBeUndefined();
  });

  it("ties check references to their execution and fingerprints receipt output only", () => {
    const criteria = [{ id: "c1", text: "", checkIndexes: [0] }];
    const run = { command: "node cli.js", exitCode: 0, output: "receipt", tests: [] };
    expect(criteriaFactsFor(criteria, contract, [green({ run, output: "tail" })], undefined, "fr-1")[0]?.basis)
      .toEqual({ kind: "check", checks: [{ index: 1, runId: "fr-1", outputHash: receiptHash("receipt") }] });
    expect(criteriaFactsFor(criteria, contract, [green({ output: "tail" })], undefined, "fr-1")[0]?.basis)
      .toEqual({ kind: "check", checks: [{ index: 1, runId: "fr-1" }] });
  });

  it.each(["file", "rendered"] as const)("keeps UI provenance and judge outcomes in %s mode", async (mode) => {
    const ui: DelegateContract = { checks: [{ ...(mode === "file" ? { type: "ui" } : { kind: "ui" }), task: "ui", criteria: ["c1"],
      ...(mode === "file" ? { path: "index.html" } : { url: "http://localhost:4173/" }) }] };
    const criteria = taskCriteria("ui", ui, CRITERIA);
    const result = green({ impeccableVersion: "4.10.0", outputHash: receiptHash("detector output") });
    const [clean] = criteriaFactsFor(criteria, ui, [result], undefined, "fr-1");
    expect(clean).toMatchObject({ state: "passed", basis: { kind: "check", checks: [
      { index: 1, runId: "fr-1", kind: "ui", impeccableVersion: "4.10.0", mode, outputHash: receiptHash("detector output") },
    ] } });
    expect(clean?.reservation).toBeUndefined();
    const warnings = { ...result, warningCount: 2 };
    expect(criteriaFactsFor(criteria, ui, [warnings], undefined)[0]).toMatchObject({ state: "passed", reservation: "check 1: 2 warnings" });
    const { verdict } = await judge([{ ...warnings, impeccableExceptions: ["low-contrast — approved by the operator: Brand logo"] }], undefined, ui);
    expect(verdict.green).toBe(true);
    expect(verdict.criteria?.[0]).toMatchObject({ state: "passed", reservation: expect.stringMatching(/2 warnings.*low-contrast.*Brand logo/) });
    expect(criteriaFactsFor(criteria, ui, [{ ...warnings, ok: false }], undefined)[0]).toMatchObject({ state: "failed" });
    expect(criteriaFactsFor(criteria, ui, [{ ...warnings, ok: false, artifactStatus: "uncheckable" }], undefined)[0]).toMatchObject({ state: "unverified" });
  });

  it("budgets exception details per check and preserves scoped rules", () => {
    const ui: DelegateContract = { checks: [
      { kind: "ui", task: "ui", criteria: ["c1"], path: "index.html" },
      { kind: "ui", task: "ui", criteria: ["c1"], path: "page.html" },
    ] };
    const [fact] = criteriaFactsFor(taskCriteria("ui", ui, CRITERIA), ui, [
      green({ warningCount: 5, impeccableExceptions: [
        "low-contrast:index.html — approved by the operator: " + "brand ".repeat(80),
        "tiny-text:index.html — approved by the operator: Legal copy", "+3 more",
      ] }),
      green({ warningCount: 1, impeccableExceptions: ["broken-image:page.html — approved by the operator: Sample image"] }),
    ], undefined);
    expect(fact?.reservation?.length).toBeLessThanOrEqual(300);
    expect(fact?.reservation).toContain("5 exceptions: low-contrast:index.html, tiny-text:index.html");
    expect(fact?.reservation).toContain("3 more");
    expect(fact?.reservation).toContain("1 exception: broken-image:page.html");
    expect(fact?.reservation).toContain("Sample image");
    expect(fact?.reservation).not.toContain("+3 more");
  });

  it("names the source of console and cleanup warnings", () => {
    const page: DelegateContract = { checks: [{ kind: "page", task: "ui", criteria: ["c1"], path: "index.html" }] };
    const [fact] = criteriaFactsFor(taskCriteria("ui", page, CRITERIA), page, [
      green({ warningCount: 3, consoleWarningCount: 2, cleanupWarning: true }),
    ], undefined);
    expect(fact?.reservation).toMatch(/3 warnings.*2 console warnings.*verification copy cleanup/);
  });

  it("keeps a passing command with a reported warning green in the judge", async () => {
    const command: DelegateContract = { checks: [{ kind: "command", task: "ui", criteria: ["c1"], cmd: "node", args: ["--version"] }] };
    const { verdict } = await judge([green({ warningCount: 1 })], undefined, command);
    expect(verdict.green).toBe(true);
    expect(verdict.criteria?.[0]).toMatchObject({ state: "passed", reservation: expect.stringContaining("1 warning") });
  });

  it("records a run check and omits the basis when no check ran", () => {
    const criteria = [{ id: "c1", text: "", checkIndexes: [0] }];
    const [passed] = criteriaFactsFor(criteria, contract, [green({ run: { command: "node cli.js", exitCode: 0, output: "result", tests: [] } })], undefined);
    expect(passed).toMatchObject({ state: "passed", basis: { kind: "check", checks: [{ index: 1, outputHash: receiptHash("result") }] } });
    const [missing] = criteriaFactsFor(criteria, contract, [], undefined);
    expect(missing?.state).toBe("failed");
    expect(missing?.basis).toBeUndefined();
    const [refused] = criteriaFactsFor(criteria, contract, [green({ ok: false, detail: "the runner returned no result" })], undefined);
    expect(refused?.state).toBe("failed");
    expect(refused?.basis).toBeUndefined();
  });

  it("passes a criterion whose checks are green, the visual one judged met", () => {
    const facts = criteriaFactsFor(taskCriteria("ui", contract, CRITERIA), contract, [green(), green({ judge: "vision", screenshots: [shot] })], new Map([["c1", { state: "passed", why: "ok", model: "cloud:vision" }], ["c2", { state: "passed", why: "ok", model: "cloud:vision" }]]));
    expect(facts.map((f) => [f.id, f.state])).toEqual([["c1", "passed"], ["c2", "passed"]]);
    expect(facts.map((f) => f.basis)).toEqual(Array(2).fill({ kind: "vision", model: "cloud:vision" }));
  });

  it("closes a task only when its checks, review and criteria are green", async () => {
    const { verdict, called } = await judge([green(), green({ judge: "vision", screenshots: [shot] })], new Map([["c1", { state: "passed", why: "ok", model: "cloud:vision" }], ["c2", { state: "passed", why: "ok", model: "cloud:vision" }]]));
    expect(called).toBe(1);
    expect(verdict.green).toBe(true);
    expect(verdict.criteria?.map((f) => f.state)).toEqual(["passed", "passed"]);
    expect(verdict.criteria?.map((f) => f.basis)).toEqual(Array(2).fill({ kind: "vision", model: "cloud:vision" }));
  });

  it("fails a criterion any of its checks fails, as a blocker fact naming its id and text", async () => {
    const { verdict, called } = await judge([green({ ok: false, detail: "exit 1" }), green({ judge: "vision", screenshots: [shot] })], new Map([["c2", { state: "passed", why: "ok" }]]));
    expect(called).toBe(0);
    expect(verdict.green).toBe(false);
    const issue = verdict.review.issues.find((i) => i.why.includes("[c1]"));
    expect(issue).toMatchObject({ severity: "blocker", by: "fact" });
    expect(issue!.why).toContain("the CLI prints the board");
    expect(issue!.why).toContain("exit 1");
    expect(verdict.criteria?.find((f) => f.id === "c1")?.state).toBe("failed");
  });

  it("names the criteria a failing game check verifies", async () => {
    const games: DelegateContract = { checks: [{ task: "ui", criteria: ["c3"], kind: "page", path: "index.html", game: { games: 3, maxMsPerGame: 1000 }, checks: ["game winners vary"] }] };
    const { verdict } = await judge([green({ ok: false, detail: "game winners vary: every game won by X" })], undefined, games);
    expect(verdict.review.issues.map((i) => i.why).join("\n")).toMatch(/\[c3\] "games end with varied winners".*every game won by X/);
  });

  it("leaves a visual criterion with no vision judgement unverified: the task goes to the director", async () => {
    const { verdict, called } = await judge([green(), green({ judge: "vision", screenshots: [shot] })]);
    expect(called).toBe(1);
    expect(verdict.green).toBe(false);
    expect(verdict.review.decision).toBe("unverified");
    expect(verdict.unverified).toContain("[c2]");
    expect(verdict.unverified).toContain("the board looks like a chess board");
    expect(verdict.criteria?.map((f) => [f.id, f.state])).toEqual([["c1", "unverified"], ["c2", "unverified"]]);
    const row: WorkerTaskResult = { id: "ui", title: "UI", status: "ok", reply: "", durationMs: 1, providerId: "p", model: "m" } as unknown as WorkerTaskResult;
    expect(applyJudgeVerdict(row, verdict, false).status).toBe("needs_orchestrator");
  });

  it("vision can only add red or unverified: never turns a red check green", async () => {
    const { verdict } = await judge([green(), green({ ok: false, detail: "pageerror", judge: "vision", screenshots: [shot] })], new Map([["c1", { state: "passed", why: "ok" }], ["c2", { state: "passed", why: "ok" }]]));
    expect(verdict.criteria?.map((f) => f.state)).toEqual(["failed", "failed"]);
  });

  it("fails a criterion vision judged not met", async () => {
    const { verdict } = await judge([green(), green({ judge: "vision", screenshots: [shot] })], new Map([["c1", { state: "passed", why: "ok" }], ["c2", { state: "failed", why: "the squares are not alternating" }]]));
    expect(verdict.green).toBe(false);
    expect(verdict.unverified).toBeUndefined();
    expect(verdict.review.issues.find((i) => i.why.includes("[c2]"))?.why).toContain("the squares are not alternating");
  });

  it("leaves a visual criterion unverified when its screenshot is missing, whatever vision said", () => {
    const facts = criteriaFactsFor(taskCriteria("ui", contract, CRITERIA), contract, [green(), green({ judge: "vision", screenshotErrors: ["screenshot: page crashed"] })], new Map([["c1", { state: "passed", why: "ok" }], ["c2", { state: "passed", why: "ok" }]]));
    expect(facts.find((f) => f.id === "c2")).toMatchObject({ state: "unverified" });
    expect(facts.find((f) => f.id === "c2")?.why).toContain("page crashed");
  });
});
