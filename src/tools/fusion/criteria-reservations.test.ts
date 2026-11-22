import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { criterionFactLine } from "../../session/project-gate-text.js";
import { applyProjectDecision, applyProjectUpdate, gateVersion, normalizeProject, type ProjectState, type ProjectUpdate } from "../../session/session-project.js";
import type { ContractCheck, DelegateContract } from "./contract.js";
import type { ContractCheckOutcome } from "./contract-checks.js";
import { criteriaFactsFor, holdOnCriteria, taskCriteria } from "./criteria-facts.js";
import { projectGateView } from "./project-gate-view.js";
import { readMilestoneEvidence, writeRunCriteriaFacts } from "./run-criteria.js";
import type { WorkerTaskResult } from "./worker-result.js";

/**
 * Issue #110: a criterion that only checks with a lint warning support
 * is "verified with reservations" — still `passed` for every verdict,
 * never shown as plain green; one clean passing check keeps it green.
 */

const WEAK: ContractCheck = { task: "t", criteria: ["c1"], kind: "command", cmd: "node", args: ["--test"], checks: ['stdout contains "passed"'] };
const CLEAN: ContractCheck = { task: "t", criteria: ["c1"], kind: "command", cmd: "node", args: ["--test", "sales.test.cjs"], checks: ["exit 0"] };
const BRIEF = new Map([["c1", { id: "c1", text: "the tests pass" }]]);
const green = (n: number): ContractCheckOutcome[] => Array.from({ length: n }, () => ({ task: "t", ok: true, detail: "ok", criteria: ["c1"] }));

describe("criteria verified with reservations (issue #110)", () => {
  it("a criterion only a warned check supports passes with a reservation", () => {
    const contract: DelegateContract = { checks: [WEAK] };
    const [fact] = criteriaFactsFor(taskCriteria("t", contract, BRIEF), contract, green(1), undefined);
    expect(fact).toMatchObject({ id: "c1", state: "passed", reservation: expect.stringContaining('also accepts failure output such as "0 passed"') });
  });

  it("one clean passing check keeps it plainly green", () => {
    const contract: DelegateContract = { checks: [WEAK, CLEAN] };
    const [fact] = criteriaFactsFor(taskCriteria("t", contract, BRIEF), contract, green(2), undefined);
    expect(fact).toEqual({ id: "c1", state: "passed", why: "every check naming it passed", basis: { kind: "check", checks: [{ index: 1 }, { index: 2 }] } });
  });

  it("a reservation does not change any verdict: the task closes", () => {
    const contract: DelegateContract = { checks: [WEAK] };
    const row = { id: "t", status: "ok", notes: [] } as unknown as WorkerTaskResult;
    const held = holdOnCriteria(row, taskCriteria("t", contract, BRIEF), contract, green(1));
    expect(held.status).toBe("ok");
    expect(held.criteria?.[0]).toMatchObject({ state: "passed", reservation: expect.any(String) });
  });

  it("is said on the fact line, not as plain green", () => {
    expect(criterionFactLine({ id: "c1", state: "passed", why: "every check naming it passed", reservation: "only asserts absences" }, [{ id: "c1", text: "Runs" }]))
      .toBe("~ c1 passed with reservations: Runs (every check naming it passed; reservations: only asserts absences) · basis not recorded");
    expect(criterionFactLine({ id: "c1", state: "passed" }, [{ id: "c1", text: "Runs" }])).toBe("✓ c1 passed: Runs · basis not recorded");
  });

  it("travels with the run's facts to the milestone, where a clean task's pass outranks a reserved one", () => {
    const state = mkdtempSync(join(tmpdir(), "fusion-reservations-"));
    const runsDir = join(state, "fusion-runs");
    try {
      writeRunCriteriaFacts(runsDir, { runId: "run-r1", sessionId: "s" }, [
        { taskId: "a", facts: [{ id: "c1", state: "passed", why: "every check naming it passed", reservation: "weak" }] },
        { taskId: "b", facts: [{ id: "c2", state: "passed", why: "every check naming it passed", reservation: "weak" }] },
      ]);
      writeRunCriteriaFacts(runsDir, { runId: "run-r2", sessionId: "s" }, [
        { taskId: "a", facts: [{ id: "c1", state: "passed", why: "every check naming it passed", reservation: "weak" }] },
        { taskId: "b", facts: [{ id: "c1", state: "passed", why: "every check naming it passed" }] },
      ]);
      const one = readMilestoneEvidence({ runsDir, stateDir: state, runIds: ["run-r1"], criteriaOrder: ["c1", "c2"] });
      expect(one.facts).toEqual([
        { id: "c1", state: "passed", why: "every check naming it passed", reservation: "weak" },
        { id: "c2", state: "passed", why: "every check naming it passed", reservation: "weak" },
      ]);
      const two = readMilestoneEvidence({ runsDir, stateDir: state, runIds: ["run-r2"], criteriaOrder: ["c1"] });
      expect(two.facts).toEqual([{ id: "c1", state: "passed", why: "every check naming it passed" }]);
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("is kept on the milestone's report and named at its gate", () => {
    const NOW = 1_700_000_000_000;
    const up = (p: ProjectState | undefined, u: ProjectUpdate): ProjectState => {
      const r = applyProjectUpdate(p, u, NOW, { stateDir: resolve("/state") });
      if (!r.ok) throw new Error(r.error.message);
      return r.project;
    };
    const approve = (p: ProjectState): ProjectState => {
      const r = applyProjectDecision(p, { gate: p.gate, version: gateVersion(p)!, verdict: "approve" }, { now: NOW });
      if (!r.ok) throw new Error(r.error.message);
      return r.project;
    };
    let project = approve(up(undefined, { kind: "brief", brief: { what: "CSV", users: "u", how: "h", successCriteria: [{ id: "c1", text: "the tests pass" }] }, draftedAfterUntrusted: false }));
    project = approve(up(project, {
      kind: "plan", milestones: [{ id: "m1", title: "Base", kind: "base" }],
      rows: [{ taskId: "t", title: "t", milestoneId: "m1", worker: "local:a", reviewer: null, reason: "preset", basis: "preset", samples: 0, estCostUsd: null, estMs: null }],
      detail: "compact",
    }));
    project = up(project, { kind: "milestone_run", id: "m1", runId: "run-1" });
    project = up(project, { kind: "milestone", id: "m1", state: "done", summary: "s", criteriaFacts: [{ id: "c1", state: "passed", why: "every check naming it passed", reservation: "only asserts absences", basis: { kind: "check", checks: [{ index: 1 }] } }] });
    const reread = normalizeProject(JSON.parse(JSON.stringify(project)))!;
    expect(reread.milestones[0]!.criteriaFacts).toEqual([{ id: "c1", state: "passed", why: "every check naming it passed", reservation: "only asserts absences", basis: { kind: "check", checks: [{ index: 1 }] } }]);
    const view = projectGateView({ sessionId: "s", project: reread, estimate: null, selectable: { workers: [], reviewers: [] } });
    expect(view.hints).toContain("verified with reservations: c1 (only asserts absences)");
  });
});

describe("a negative control that failed as it should clears a lint reservation (issue #110)", () => {
  it("a warned check with a working negative keeps its criterion plainly green", () => {
    const controlled: ContractCheck = { ...WEAK, negative: { args: ["--test", "broken.test.cjs"] } };
    const contract: DelegateContract = { checks: [controlled] };
    const [fact] = criteriaFactsFor(taskCriteria("t", contract, BRIEF), contract, green(1), undefined);
    expect(fact).toEqual({ id: "c1", state: "passed", why: "every check naming it passed", basis: { kind: "check", checks: [{ index: 1 }] } });
  });
});
