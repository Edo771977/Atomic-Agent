/**
 * Issue #98 item 1: a milestone closes only when each required task (the
 * approved plan's rows for it) has a current accept from the reviewer.
 * An open needs-changes, a missing verdict, or a no_changes after
 * needs-changes keeps it open, even under auto-approval.
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
import type { ToolContext } from "../tool-registry.js";
import { buildProjectTools, PROJECT_UPDATE_DETAIL, type ProjectToolDeps } from "./project-tools.js";
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
const decide = (p: ProjectState, verdict: "approve" | "edit", edits?: { note: string }) =>
  applyProjectDecision(p, { gate: p.gate, version: gateVersion(p)!, verdict, ...(edits === undefined ? {} : { edits }) }, { now: NOW });
const approve = (p: ProjectState): ProjectState => {
  const r = decide(p, "approve");
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
};

describe("a milestone stays open while a required task lacks a current accept (issue #98)", () => {
  it("accept + needs-changes → no_changes keeps it open under auto-approval; an evidence-only re-review that accepts closes it", async () => {
    const state = mkdtempSync(join(tmpdir(), "review-gate-"));
    try {
      const runs = join(state, FUSION_RUNS_DIR_NAME);
      const run = (runId: string, reviews: RunTaskReview[]) => writeRunCriteriaFacts(runs, { runId, sessionId: "s" }, [], undefined, reviews);
      const evidence: NonNullable<ProjectToolDeps["milestoneEvidence"]> = (milestone, order, current) =>
        readMilestoneEvidence({ runsDir: runs, stateDir: state, runIds: milestone.runIds, criteriaOrder: order, ...current });
      const [, , milestoneTool] = buildProjectTools({ planContext: () => { throw new Error("unused"); }, outsideContent: () => false, milestoneEvidence: evidence });
      const report = async (p: ProjectState) => {
        const ctx = { workingDir: "/tmp", sessionId: "s", stepIndex: 0, project: p } as unknown as ToolContext;
        return milestoneTool!.run({ id: "m1", state: "done", summary: "both suites green" }, ctx);
      };

      let p = fold(undefined, { kind: "brief", brief: { what: "CSV sales", users: "ops", how: "node", successCriteria: ["sums revenue"] }, draftedAfterUntrusted: false });
      p = approve(fold(approve(p), { kind: "plan", milestones: [{ id: "m1", title: "CLI", kind: "base" }], rows: [row("program"), row("tests")], detail: "compact" }));
      p = fold(p, { kind: "milestone_run", id: "m1", runId: "fr-1" });
      run("fr-1", [{ taskId: "program", verdict: "accept" }, { taskId: "tests", verdict: "needs-changes" }]);
      p = fold(p, { kind: "milestone_run", id: "m1", runId: "fr-2" });
      run("fr-2", [{ taskId: "tests", verdict: "none", reason: "the task ended no_changes before review" }]);

      const first = await report(p);
      expect(first.status).toBe("ok");
      expect(first.summary).toMatch(/review open: tests/i);
      p = fold(p, first.details[PROJECT_UPDATE_DETAIL] as ProjectUpdate);
      expect(p.milestones[0]!.reviewBlocks).toEqual([{ taskId: "tests", reason: expect.stringMatching(/no verdict/) }]);
      // Auto-approval is the same decision: refused with the reason.
      const refused = decide(p, "approve");
      expect(refused).toMatchObject({ ok: false, error: { code: "review-open" } });
      if (!refused.ok) expect(refused.error.message).toMatch(/tests/);
      expect(p.milestones[0]!.state).toBe("done");

      // The director re-delegates the test task; a re-review of the same file with new evidence accepts it.
      const corrected = decide(p, "edit", { note: "re-review the tests with their counts" });
      if (!corrected.ok) throw new Error(corrected.error.message);
      p = fold(corrected.project, { kind: "milestone_run", id: "m1", runId: "fr-3" });
      run("fr-3", [{ taskId: "tests", verdict: "accept" }]);
      p = fold(p, (await report(p)).details[PROJECT_UPDATE_DETAIL] as ProjectUpdate);
      expect(p.milestones[0]!.reviewBlocks).toBeUndefined();
      p = approve(p);
      expect(p.milestones[0]!.state).toBe("reviewed");
    } finally { rmSync(state, { recursive: true, force: true }); }
  });

  it("without any reviewer verdicts in the runs (review off), nothing blocks", () => {
    const state = mkdtempSync(join(tmpdir(), "review-off-"));
    try {
      const runs = join(state, FUSION_RUNS_DIR_NAME);
      writeRunCriteriaFacts(runs, { runId: "fr-1", sessionId: "s" }, [{ taskId: "program", facts: [{ id: "c1", state: "passed" }] }]);
      const out = readMilestoneEvidence({ runsDir: runs, stateDir: state, runIds: ["fr-1"], criteriaOrder: ["c1"], requiredTasks: ["program", "tests"] });
      expect(out.reviewBlocks).toBeUndefined();
    } finally { rmSync(state, { recursive: true, force: true }); }
  });
});
