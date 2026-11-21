import childProcess from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyProjectDecision, applyProjectUpdate, gateVersion, normalizeProject, type AssignmentRow, type ProjectState } from "../../session/session-project.js";
import { gateContentHash, projectContent } from "../../session/project-decisions.js";
import { evaluatePlanChecks } from "./plan-checks.js";
import { projectGateView } from "./project-gate-view.js";
import { parseProjectPlanArgs } from "./project-tools.js";
import type { ContractCheck } from "./contract.js";

const check: ContractCheck = { kind: "command", cmd: "node", args: ["test.cjs", "good"], checks: ["stdout contains RESULT=42"], criteria: ["c1"], negative: { args: ["test.cjs", "bad"] } };
const row = (taskId: string, checks?: ContractCheck[]): AssignmentRow => ({ taskId, title: taskId, milestoneId: "m1", worker: "local:model", reviewer: null, reason: "preset", basis: "preset", samples: 0, estCostUsd: null, estMs: null, ...(checks === undefined ? {} : { checks }) });
const criteria = [{ id: "c1", text: "Computes 42" }, { id: "c2", text: "Rejects invalid input" }];
function draft(rows = [row("t1", [check]), row("t2")]): ProjectState {
  const p: ProjectState = { brief: { version: 1, what: "Calculator", users: "People", how: "Node", successCriteria: criteria, status: "approved", draftedAfterUntrusted: false }, approvedCriteria: criteria, milestones: [], gate: { kind: "none" } };
  const r = applyProjectUpdate(p, { kind: "plan", milestones: [{ id: "m1", title: "Build", kind: "base" }], rows, detail: "full" }, 1);
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
}
afterEach(() => vi.restoreAllMocks());

describe("pure plan checks", () => {
  it("reports lint, approved criteria coverage and tasks without checks", () => {
    const results = evaluatePlanChecks([row("t1", [check]), row("t2")], criteria);
    expect(results).toEqual(expect.arrayContaining([
      { dimension: "check-lint", verdict: "pass", detail: expect.any(String), taskIds: ["t1"] },
      { dimension: "criteria-coverage", verdict: "warn", detail: expect.stringContaining("c2"), taskIds: [] },
      { dimension: "verifiability", verdict: "warn", detail: expect.any(String), taskIds: ["t2"] },
    ]));
    expect(evaluatePlanChecks([row("t1", [check])], criteria, { blockingDimensions: ["criteria-coverage"] })).toContainEqual(expect.objectContaining({ dimension: "criteria-coverage", verdict: "fail" }));
  });
  it("maps severe lint to fail and warnings to warn; legacy plans stay verifiable", () => {
    const fixed = { cmd: "echo ok", checks: ["stdout contains ok"] };
    expect(evaluatePlanChecks([row("t1", [fixed])], [])).toContainEqual(expect.objectContaining({ dimension: "check-lint", verdict: "fail", taskIds: ["t1"] }));
    expect(evaluatePlanChecks([row("t1", [{ cmd: "node test.cjs", checks: ["stdout contains passed"] }])], [])).toContainEqual(expect.objectContaining({ dimension: "check-lint", verdict: "warn" }));
    expect(evaluatePlanChecks([row("t1")], [])).toContainEqual(expect.objectContaining({ dimension: "verifiability", verdict: "pass" }));
  });
  it("never executes a command or uses the network, even for hostile specs", () => {
    const spawn = vi.spyOn(childProcess, "spawn").mockImplementation(() => { throw new Error("executed"); });
    const exec = vi.spyOn(childProcess, "execSync").mockImplementation(() => { throw new Error("executed"); });
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    evaluatePlanChecks([row("t1", [{ cmd: "curl https://example.invalid", checks: ["exit 0"] }, check])], criteria);
    expect(spawn).not.toHaveBeenCalled(); expect(exec).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
});

describe("plan check persistence and gates", () => {
  it("stores checks, fingerprints their negative input and recomputes results on load", () => {
    const p = draft();
    expect(p.plan?.checkResults).toEqual(evaluatePlanChecks(p.plan!.rows, criteria));
    expect(normalizeProject(JSON.parse(JSON.stringify(p)))).toEqual(p);
    const changed = draft([row("t1", [{ ...check, negative: { stdin: "bad" } }])]);
    expect(gateContentHash(changed, { kind: "plan" })).not.toBe(gateContentHash(p, { kind: "plan" }));
    const legacy = draft([row("t1")]);
    expect(legacy.plan?.checkResults).toContainEqual(expect.objectContaining({ dimension: "criteria-coverage", verdict: "warn" }));
    expect(normalizeProject(legacy)?.plan?.checkResults).toEqual(legacy.plan?.checkResults);
    expect(projectContent(p).plan?.checkResults).toBeUndefined();
    const raw = JSON.parse(JSON.stringify(draft([row("t1", [{ cmd: "echo ok" }])])));
    raw.plan.checkResults = [];
    expect(normalizeProject(raw)?.plan?.checkResults).toContainEqual(expect.objectContaining({ verdict: "fail" }));
  });
  it("shows results at the plan gate and refuses a fail through existing review blocks", () => {
    const p = draft([row("t1", [{ cmd: "echo ok" }])]);
    const view = projectGateView({ sessionId: "s", project: p, estimate: null, selectable: { workers: [], reviewers: [] } });
    expect(view.hints.some((h) => h.includes("check-lint") && h.includes("fail"))).toBe(true);
    const r = applyProjectDecision(p, { gate: p.gate, version: gateVersion(p)!, verdict: "approve" }, { now: 2 });
    expect(r).toMatchObject({ ok: false, error: { code: "review-open", blocks: [{ taskId: "t1", reason: expect.stringContaining("check-lint") }] } });
    const warn = draft();
    expect(applyProjectDecision(warn, { gate: warn.gate, version: gateVersion(warn)!, verdict: "approve" }, { now: 2 }).ok).toBe(true);
    expect(applyProjectDecision(warn, { gate: warn.gate, version: gateVersion(warn)!, verdict: "approve" }, { now: 2, planChecks: { blockingDimensions: ["criteria-coverage"] } })).toMatchObject({ ok: false, error: { code: "review-open" } });
    const strictView = projectGateView({ sessionId: "s", project: warn, estimate: null, selectable: { workers: [], reviewers: [] }, planChecks: { blockingDimensions: ["criteria-coverage"] } });
    expect(strictView.hints).toContainEqual(expect.stringMatching(/criteria-coverage: fail/));
  });
  it("refreshes coverage only when the person approves revised criteria", () => {
    const p = draft();
    const updated = applyProjectUpdate(p, { kind: "brief", brief: { what: "Calculator", users: "People", how: "Node", successCriteria: [criteria[0]!] }, draftedAfterUntrusted: false }, 2);
    if (!updated.ok) throw new Error(updated.error.message);
    expect(updated.project.plan?.checkResults).toEqual(p.plan?.checkResults);
    const approved = applyProjectDecision(updated.project, { gate: updated.project.gate, version: gateVersion(updated.project)!, verdict: "approve" }, { now: 3 });
    expect(approved.ok && approved.project.plan?.checkResults).toContainEqual(expect.objectContaining({ dimension: "criteria-coverage", verdict: "pass" }));
  });
  it("uses contract validation for plan checks, including task ownership, criteria, vision and negative", () => {
    const args = (checks: unknown) => ({ milestones: [{ id: "m1", title: "Build", kind: "base" }], tasks: [{ id: "t1", title: "Build", milestone: "m1", checks }] });
    expect(parseProjectPlanArgs(args([check]))).toMatchObject({ ok: true, plan: { tasks: [{ checks: [check] }] } });
    for (const bad of ["oops", [null], [{}], [{ ...check, task: "other" }], [{ ...check, criteria: ["Bad Id"] }], [{ ...check, judge: "vision" }], [{ ...check, negative: { args: ["test.cjs", "good"] } }], Array.from({ length: 25 }, () => check)]) {
      expect(parseProjectPlanArgs(args(bad)), JSON.stringify(bad)).toMatchObject({ ok: false });
    }
  });
});
