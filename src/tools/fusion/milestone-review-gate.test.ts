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
import { projectGateView } from "./project-gate-view.js";
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

      // The done report is refused while a block stands: the milestone stays in progress for the director.
      const first = await report(p);
      expect(first.status).toBe("error");
      expect(first.summary).toMatch(/tests \(no verdict: the task ended no_changes/);
      expect(first.summary).toMatch(/re-delegate it with its plan task id tests/);
      expect(p.milestones[0]!.state).toBe("in_progress");
      // A failed report keeps the blocks for the person's gate, which refuses to approve them over (older stores too).
      const failed = await milestoneTool!.run({ id: "m1", state: "failed", summary: "tests not accepted" }, { workingDir: "/tmp", sessionId: "s", stepIndex: 0, project: p } as unknown as ToolContext);
      p = fold(p, failed.details[PROJECT_UPDATE_DETAIL] as ProjectUpdate);
      expect(p.milestones[0]!.reviewBlocks).toEqual([{ taskId: "tests", reason: expect.stringMatching(/no verdict/) }]);
      const view = projectGateView({ sessionId: "s", project: p, estimate: null, selectable: { workers: [], reviewers: [] } });
      expect(view.hints).toEqual([expect.stringMatching(/^review open: tests \(no verdict/)]);
      const stored: ProjectState = { ...p, milestones: p.milestones.map((m) => ({ ...m, state: "done" as const })) };
      const refused = decide(stored, "approve");
      expect(refused).toMatchObject({ ok: false, error: { code: "review-open" } });
      if (!refused.ok) expect(refused.error.message).toMatch(/tests/);

      // The director re-delegates the test task; a re-review of the same file with new evidence accepts it.
      // Approving the failed result sends it back for another run.
      p = fold(approve(p), { kind: "milestone_run", id: "m1", runId: "fr-3" });
      run("fr-3", [{ taskId: "tests", verdict: "accept" }]);
      p = fold(p, (await report(p)).details[PROJECT_UPDATE_DETAIL] as ProjectUpdate);
      expect(p.milestones[0]!.reviewBlocks).toBeUndefined();
      p = approve(p);
      expect(p.milestones[0]!.state).toBe("reviewed");
    } finally { rmSync(state, { recursive: true, force: true }); }
  });

  it("an accept counts only from the task's newest run; a run that reviewed nothing blocks (issue #98 review)", () => {
    const state = mkdtempSync(join(tmpdir(), "review-latest-"));
    try {
      const runs = join(state, FUSION_RUNS_DIR_NAME);
      const read = (runIds: string[]) =>
        readMilestoneEvidence({ runsDir: runs, stateDir: state, runIds, criteriaOrder: [], requiredTasks: ["program", "tests"] }).reviewBlocks;
      writeRunCriteriaFacts(runs, { runId: "fr-1", sessionId: "s" }, [], undefined,
        [{ taskId: "program", verdict: "accept" }, { taskId: "tests", verdict: "accept" }], { ran: ["program", "tests"], judging: true });
      expect(read(["fr-1"])).toBeUndefined();
      // tests ran again and changed its files, but no review was recorded for it.
      writeRunCriteriaFacts(runs, { runId: "fr-2", sessionId: "s" }, [], undefined, [], { ran: ["tests"], judging: true });
      expect(read(["fr-1", "fr-2"])).toEqual([{ taskId: "tests", reason: "not reviewed in its latest run" }]);
      // A milestone whose only run recorded no review at all is not "nothing blocks".
      writeRunCriteriaFacts(runs, { runId: "fr-9", sessionId: "s" }, [], undefined, [], { ran: ["program", "tests"], judging: false });
      expect(read(["fr-9"])).toEqual([
        { taskId: "program", reason: "no reviewer ran in its latest run" },
        { taskId: "tests", reason: "no reviewer ran in its latest run" },
      ]);
      // A fresh accept in the newest run clears it.
      writeRunCriteriaFacts(runs, { runId: "fr-3", sessionId: "s" }, [], undefined, [{ taskId: "tests", verdict: "accept" }], { ran: ["tests"], judging: true });
      expect(read(["fr-1", "fr-2", "fr-3"])).toBeUndefined();
    } finally { rmSync(state, { recursive: true, force: true }); }
  });

  it("a plan row with no review is not required: the milestone closes on its reviewed rows' accepts", async () => {
    const state = mkdtempSync(join(tmpdir(), "review-none-row-"));
    try {
      const runs = join(state, FUSION_RUNS_DIR_NAME);
      const evidence: NonNullable<ProjectToolDeps["milestoneEvidence"]> = (milestone, order, current) =>
        readMilestoneEvidence({ runsDir: runs, stateDir: state, runIds: milestone.runIds, criteriaOrder: order, ...current });
      const [, , milestoneTool] = buildProjectTools({ planContext: () => { throw new Error("unused"); }, outsideContent: () => false, milestoneEvidence: evidence });
      let p = fold(undefined, { kind: "brief", brief: { what: "CSV sales", users: "ops", how: "node", successCriteria: ["sums revenue"] }, draftedAfterUntrusted: false });
      p = approve(fold(approve(p), { kind: "plan", milestones: [{ id: "m1", title: "CLI", kind: "base" }], rows: [row("program"), { ...row("docs"), reviewer: null }], detail: "compact" }));
      p = fold(p, { kind: "milestone_run", id: "m1", runId: "fr-1" });
      writeRunCriteriaFacts(runs, { runId: "fr-1", sessionId: "s" }, [], undefined, [{ taskId: "program", verdict: "accept" }]);
      const ctx = { workingDir: "/tmp", sessionId: "s", stepIndex: 0, project: p } as unknown as ToolContext;
      const done = await milestoneTool!.run({ id: "m1", state: "done", summary: "ok" }, ctx);
      expect(done.summary).not.toMatch(/review open/i);
      p = approve(fold(p, done.details[PROJECT_UPDATE_DETAIL] as ProjectUpdate));
      expect(p.milestones[0]!.state).toBe("reviewed");
    } finally { rmSync(state, { recursive: true, force: true }); }
  });
});

