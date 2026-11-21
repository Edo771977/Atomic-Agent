import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ApprovalGate, type ApprovalRequest } from "../../approval/approval-gate.js";
import type { ContractCheck } from "./contract.js";
import { createContractCheckHold } from "./contract-check-hold.js";
import { applyCheckOutcomes, renderContractLine, runContractChecks, type ContractCheckResult, type ContractCheckRunner } from "./contract-checks.js";
import type { WorkerTaskResult } from "./worker-result.js";
import { criteriaFactsFor, taskCriteria } from "./criteria-facts.js";
import { parseDelegateArgs } from "./delegate-args.js";
import { checkSpecKey } from "./worker-self-check.js";

/**
 * Issue #110: a check may declare a negative control — the same command
 * on an input that must fail. It runs first, through the same runner
 * (approval, read scope, egress, cancellation); one that passes marks
 * the check unreliable, and its criterion does not pass.
 */

const cwd = resolve("contract-negative-fixture");
const signal = new AbortController().signal;
const TASKS = [{ id: "t", instructions: "write sales.cjs", files: ["sales.cjs"] }];
const CHECK: ContractCheck = {
  task: "t",
  criteria: ["c1"],
  kind: "command",
  cmd: "node",
  args: ["check-sum.js", "good.csv"],
  checks: ["exit 0", 'stdout contains "{\\"A\\":6}"'],
  negative: { args: ["check-sum.js", "bad.csv"] },
};

/** A runner that answers each spec by its args: `bad.csv` gets `negativeOk`. */
function runner(negativeOk: boolean) {
  return vi.fn<ContractCheckRunner>(async (specs) => ({
    ok: true,
    results: specs.map((spec): ContractCheckResult => {
      const bad = Array.isArray(spec.args) && spec.args.includes("bad.csv");
      return bad ? { ok: negativeOk, summary: negativeOk ? "verify.run command: ok" : "verify.run command: FAILED" } : { ok: true, summary: "verify.run command: ok" };
    }),
  }));
}

describe("contract check negative control — parsing", () => {
  const parse = (check: Record<string, unknown>) => parseDelegateArgs({ tasks: TASKS, contract: { checks: [check] } });

  it("keeps a command check's negative input", () => {
    const parsed = parse({ task: "t", kind: "command", cmd: "node", args: ["sum.js"], stdin: "A,2,3\n", negative: { stdin: "A,x,3\n" } });
    expect(parsed.ok && parsed.contract?.checks?.[0]?.negative).toEqual({ stdin: "A,x,3\n" });
  });

  it("refuses a negative that is not an input change of a command check", () => {
    const error = (check: Record<string, unknown>) => {
      const parsed = parse(check);
      return parsed.ok ? "" : parsed.error;
    };
    expect(error({ task: "t", kind: "page", path: "index.html", checks: ["no errors"], negative: { stdin: "x" } })).toContain("contract.checks[0].negative applies to command checks");
    expect(error({ task: "t", cmd: "node", args: ["a.js"], negative: { cmd: "rm" } })).toContain("contract.checks[0].negative: unknown key `cmd`");
    expect(error({ task: "t", cmd: "node", args: ["a.js"], negative: {} })).toContain("contract.checks[0].negative needs `args`, `stdin` or `env`");
    expect(error({ task: "t", cmd: "node", args: ["a.js"], negative: { args: ["a.js"] } })).toContain("contract.checks[0].negative runs the same input as the check");
    expect(error({ task: "t", cmd: "node a.js", negative: { args: ["b.js"] } })).toContain("contract.checks[0].negative.args needs the check's command as `cmd` plus `args`");
  });

  it("is not part of the check's identity, nor of what a worker is shown to run", () => {
    const { negative: _negative, ...plain } = CHECK;
    expect(checkSpecKey(CHECK)).toBe(checkSpecKey(plain));
  });
});

describe("contract check negative control — running", () => {
  it("runs the negative first, as its own batch, then the checks without the field", async () => {
    const run = runner(false);
    const { outcomes } = await runContractChecks([CHECK], run, { workingDir: cwd, signal });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]![0]).toEqual([{ kind: "command", cmd: "node", args: ["check-sum.js", "bad.csv"], checks: CHECK.checks }]);
    expect(run.mock.calls[1]![0]).toEqual([{ kind: "command", cmd: "node", args: ["check-sum.js", "good.csv"], checks: CHECK.checks }]);
    expect(outcomes[0]).toMatchObject({ ok: true });
    expect(outcomes[0]).not.toHaveProperty("unreliable");
  });

  it("marks a check whose negative also passes unreliable, and its criterion is not passed", async () => {
    const { outcomes } = await runContractChecks([CHECK], runner(true), { workingDir: cwd, signal });
    expect(outcomes[0]).toMatchObject({ ok: true, unreliable: expect.stringContaining("negative control") });
    const criteria = taskCriteria("t", { checks: [CHECK] }, new Map([["c1", { id: "c1", text: "sums per sku" }]]));
    const [fact] = criteriaFactsFor(criteria, { checks: [CHECK] }, outcomes, undefined);
    expect(fact).toMatchObject({ id: "c1", state: "unverified", why: expect.stringContaining("check 1 is unreliable") });
  });

  it("a negative that could not run is no verdict on the check", async () => {
    const run = vi.fn<ContractCheckRunner>(async (specs) => ({
      ok: false,
      results: specs.map((spec) => (Array.isArray(spec.args) && spec.args.includes("bad.csv") ? { ok: false, error: "refused by the egress rule" } : { ok: true })),
    }));
    const { outcomes } = await runContractChecks([CHECK], run, { workingDir: cwd, signal });
    expect(outcomes[0]).toMatchObject({ ok: true, negative: "not run: refused by the egress rule" });
    expect(outcomes[0]).not.toHaveProperty("unreliable");
  });

  it("goes through the same approval as the check: the person sees the negative command, a refusal runs nothing", async () => {
    const requests: ApprovalRequest[] = [];
    const make = (deny: boolean) => {
      const gate: ApprovalGate = new ApprovalGate({ level: 1, emit: (request) => {
        requests.push(request);
        queueMicrotask(() => gate.resolve({ approvalId: request.approvalId, approved: !deny }));
      } });
      gate.setTaintReview(() => true);
      gate.setRules({ list: () => [], add: () => { throw new Error("unused"); }, remove: () => false });
      const inner = Object.assign(runner(false), { supportsInputIntegrity: true as const });
      const hold = createContractCheckHold({ runner: inner, approvals: gate, approvalRequired: true, sessionId: "parent", workingDir: cwd, tool: "fusion.delegate", checks: [CHECK], signal });
      return { inner, hold };
    };
    const allowed = make(false);
    await runContractChecks([CHECK], allowed.hold.runner, { workingDir: cwd, signal });
    expect(requests.map((r) => r.preview ?? "").join("\n")).toContain("bad.csv");
    expect(allowed.inner).toHaveBeenCalledTimes(2);

    const denied = make(true);
    const result = await runContractChecks([CHECK], denied.hold.runner, { workingDir: cwd, signal });
    expect(denied.inner).not.toHaveBeenCalled();
    expect(result.outcomes).toEqual([]);
    expect(result.checksSkipped).toMatch(/^1 check not run/);
  });

  it("the hold's own preflight of the declared checks authorizes the negative's command too", async () => {
    const requests: ApprovalRequest[] = [];
    const gate: ApprovalGate = new ApprovalGate({ level: 1, emit: (request) => {
      requests.push(request);
      queueMicrotask(() => gate.resolve({ approvalId: request.approvalId, approved: true }));
    } });
    gate.setTaintReview(() => true);
    gate.setRules({ list: () => [], add: () => { throw new Error("unused"); }, remove: () => false });
    const hold = createContractCheckHold({ runner: runner(false), approvals: gate, approvalRequired: true, sessionId: "parent", workingDir: cwd, tool: "fusion.delegate", checks: [CHECK], signal });
    expect(await hold.decide(signal)).toBeUndefined();
    const preview = requests.map((r) => r.preview ?? "").join("\n");
    expect(preview).toContain("bad.csv");
    expect(preview).toContain("good.csv");
  });
});

describe("contract check negative control — one that could not run is said", () => {
  const notRun = { task: "t", ok: true, detail: "ok", criteria: ["c1"], negative: "not run: refused by the egress rule" };
  it("on the row and the contract line", () => {
    const [row] = applyCheckOutcomes([{ id: "t", status: "ok", notes: [] } as unknown as WorkerTaskResult], [notRun]);
    expect(row!.notes).toContain("checks: negative control not run — ok (not run: refused by the egress rule)");
    expect(renderContractLine({ findings: [], checks: [notRun] })).toContain("1 negative control not run");
  });
  it("as a reservation on the criterion, never plain green", () => {
    const criteria = taskCriteria("t", { checks: [CHECK] }, new Map([["c1", { id: "c1", text: "sums per sku" }]]));
    const [fact] = criteriaFactsFor(criteria, { checks: [CHECK] }, [notRun], undefined);
    expect(fact).toMatchObject({ id: "c1", state: "passed", reservation: "check 1: its negative control did not run (not run: refused by the egress rule)" });
  });
});
