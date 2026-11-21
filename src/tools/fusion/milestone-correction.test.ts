/**
 * Issue #100 item 1: after a needs-changes with concrete blockers, the
 * director gets bounded correction rounds before it may report the
 * milestone failed; past them the milestone stays open (review-open).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  applyProjectDecision,
  applyProjectUpdate,
  gateVersion,
  type AssignmentRow,
  type ProjectState,
  type ProjectUpdate,
} from "../../session/session-project.js";
import { settleProjectGate } from "../../cli/run-project-gate.js";
import type { ToolContext } from "../tool-registry.js";
import { projectGateView } from "./project-gate-view.js";
import { buildProjectTools, MILESTONE_CORRECTION_ROUNDS, PROJECT_UPDATE_DETAIL, type ProjectToolDeps } from "./project-tools.js";
import { FUSION_RUNS_DIR_NAME } from "./run-checkpoint.js";
import { readMilestoneEvidence, writeRunCriteriaFacts, type RunTaskReview } from "./run-criteria.js";

const NOW = Date.now();
const row = (taskId: string): AssignmentRow => ({
  taskId, title: taskId, milestoneId: "m1", worker: "local:qwen", reviewer: "codex-cli:default", reason: "preset",
  basis: "preset", samples: 0, estCostUsd: 0, estMs: 1000,
});
const fold = (p: ProjectState | undefined, u: ProjectUpdate): ProjectState => {
  const r = applyProjectUpdate(p, u, NOW);
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
};
const approve = (p: ProjectState): ProjectState => {
  const r = applyProjectDecision(p, { gate: p.gate, version: gateVersion(p)!, verdict: "approve" }, { now: NOW });
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
};
// The two defects of the live run.
const BLANK_LINES: RunTaskReview = { taskId: "program", verdict: "needs-changes", issues: [{ severity: "blocker", text: "sales.cjs: blank lines are no longer skipped" }] };
const NEW_FUNCTION: RunTaskReview = { taskId: "tests", verdict: "needs-changes", issues: [{ severity: "blocker", text: "sales.test.cjs: parses the output with new Function, not JSON.parse" }] };

function harness(budgetLeft = true) {
  const state = mkdtempSync(join(tmpdir(), "correction-"));
  const runs = join(state, FUSION_RUNS_DIR_NAME);
  const evidence: NonNullable<ProjectToolDeps["milestoneEvidence"]> = (milestone, order, current) =>
    readMilestoneEvidence({ runsDir: runs, stateDir: state, runIds: milestone.runIds, criteriaOrder: order, ...current });
  const [, , tool] = buildProjectTools({
    planContext: () => { throw new Error("unused"); },
    outsideContent: () => false,
    milestoneEvidence: evidence,
    correctionBudgetLeft: () => budgetLeft,
  });
  let p = fold(undefined, { kind: "brief", brief: { what: "CSV sales", users: "ops", how: "node", successCriteria: ["sums revenue"] }, draftedAfterUntrusted: false });
  p = approve(fold(approve(p), { kind: "plan", milestones: [{ id: "m1", title: "CLI", kind: "base" }], rows: [row("program"), row("tests")], detail: "compact" }));
  let n = 0;
  return {
    get project() { return p; },
    /** A fan-out of the milestone that recorded these reviews. */
    run(reviews: RunTaskReview[]) {
      const runId = `fr-${++n}`;
      p = fold(p, { kind: "milestone_run", id: "m1", runId });
      writeRunCriteriaFacts(runs, { runId, sessionId: "s" }, [], undefined, reviews, { ran: reviews.map((r) => r.taskId), judging: true });
    },
    report(state: "done" | "failed") {
      return tool!.run({ id: "m1", state, summary: state === "done" ? "both suites green" : "two defects remain" }, { workingDir: "/tmp", sessionId: "s", stepIndex: 0, project: p } as unknown as ToolContext);
    },
    fold(u: ProjectUpdate) { p = fold(p, u); },
    cleanup() { rmSync(state, { recursive: true, force: true }); },
  };
}

describe("bounded correction after needs-changes (issue #100)", () => {
  it("the director may not give up while a round remains: it fixes both defects, both are re-reviewed, the milestone closes", async () => {
    const h = harness();
    try {
      expect(MILESTONE_CORRECTION_ROUNDS).toBe(2);
      h.run([BLANK_LINES, NEW_FUNCTION]);
      const giveUp = await h.report("failed");
      // Not recorded as failed: the hold is folded (it counts the refusal), the milestone stays in progress.
      expect((giveUp.details[PROJECT_UPDATE_DETAIL] as { holdForCorrection?: true }).holdForCorrection).toBe(true);
      h.fold(giveUp.details[PROJECT_UPDATE_DETAIL] as ProjectUpdate);
      expect(giveUp.summary).toMatch(/not reported failed/i);
      expect(giveUp.summary).toMatch(/correction round 1 of 2/);
      expect(giveUp.summary).toContain("program: sales.cjs: blank lines are no longer skipped");
      expect(giveUp.summary).toContain("tests: sales.test.cjs: parses the output with new Function, not JSON.parse");
      expect(giveUp.summary).toMatch(/targeted fix .* under its plan task id/);
      expect(h.project.milestones[0]!.state).toBe("in_progress");
      // The targeted fixes run under the rows' ids; both suites rerun and both reviews accept.
      h.run([{ taskId: "program", verdict: "accept" }, { taskId: "tests", verdict: "accept" }]);
      const done = await h.report("done");
      expect(done.status).toBe("ok");
      h.fold(done.details[PROJECT_UPDATE_DETAIL] as ProjectUpdate);
      expect(approve(h.project).milestones[0]!.state).toBe("reviewed");
    } finally { h.cleanup(); }
  });

  it("blockers that persist past the rounds leave the milestone open, never closed automatically", async () => {
    const h = harness();
    try {
      for (let round = 0; round <= MILESTONE_CORRECTION_ROUNDS; round += 1) h.run([BLANK_LINES, NEW_FUNCTION]);
      const failed = await h.report("failed");
      expect(failed.status).toBe("ok");
      h.fold(failed.details[PROJECT_UPDATE_DETAIL] as ProjectUpdate);
      expect(h.project.milestones[0]).toMatchObject({ state: "failed", reviewBlocks: [{ taskId: "program" }, { taskId: "tests" }] });
      const step = await settleProjectGate({
        projectState: () => projectGateView({ sessionId: "s", project: h.project, estimate: null, selectable: { workers: [], reviewers: [] } }),
        projectDecision: () => { throw new Error("never decided automatically"); },
      } as never, "s", "approve");
      expect(step.kind).toBe("stop");
    } finally { h.cleanup(); }
  });

  it("with the budget gone, the director may report it failed at once (it stays open)", async () => {
    const h = harness(false);
    try {
      h.run([BLANK_LINES, NEW_FUNCTION]);
      expect((await h.report("failed")).status).toBe("ok");
    } finally { h.cleanup(); }
  });

  it("fixes delegated under other task ids still use up the rounds", async () => {
    const h = harness();
    try {
      h.run([BLANK_LINES, NEW_FUNCTION]);
      // The director fixes under new ids: the plan rows' reviews stay needs-changes.
      h.run([{ taskId: "program-fix", verdict: "accept" }, { taskId: "tests-fix", verdict: "accept" }]);
      const second = await h.report("failed");
      expect(second.summary).toMatch(/correction round 2 of 2/);
      h.fold(second.details[PROJECT_UPDATE_DETAIL] as ProjectUpdate);
      h.run([{ taskId: "program-fix-2", verdict: "accept" }]);
      const third = await h.report("failed");
      h.fold(third.details[PROJECT_UPDATE_DETAIL] as ProjectUpdate);
      expect(h.project.milestones[0]!.state).toBe("failed");
    } finally { h.cleanup(); }
  });

  it("the refusals themselves are capped at 2: with no budget cap the loop still ends", async () => {
    const h = harness();
    try {
      h.run([BLANK_LINES, NEW_FUNCTION]);
      for (let i = 0; i < 2; i += 1) {
        const held = await h.report("failed");
        expect((held.details[PROJECT_UPDATE_DETAIL] as { holdForCorrection?: true }).holdForCorrection).toBe(true);
        h.fold(held.details[PROJECT_UPDATE_DETAIL] as ProjectUpdate);
      }
      expect(h.project.milestones[0]!.failedRefusals).toBe(2);
      const third = await h.report("failed");
      h.fold(third.details[PROJECT_UPDATE_DETAIL] as ProjectUpdate);
      expect(h.project.milestones[0]).toMatchObject({ state: "failed", reviewBlocks: [{ taskId: "program" }, { taskId: "tests" }] });
    } finally { h.cleanup(); }
  });

  it("when a reviewer could not run, reporting failed is not refused", async () => {
    const h = harness();
    try {
      h.run([BLANK_LINES]);
      // tests ran with no reviewer able to answer.
      h.run([{ taskId: "program", verdict: "needs-changes", issues: [{ severity: "blocker", text: "sales.cjs: blank lines" }] }, { taskId: "tests", verdict: "none", reason: "not verified: the judge could not run: codex-cli exited 1" }]);
      const failed = await h.report("failed");
      expect((failed.details[PROJECT_UPDATE_DETAIL] as { holdForCorrection?: true }).holdForCorrection).toBeUndefined();
      h.fold(failed.details[PROJECT_UPDATE_DETAIL] as ProjectUpdate);
      expect(h.project.milestones[0]!.state).toBe("failed");
    } finally { h.cleanup(); }
  });
});

