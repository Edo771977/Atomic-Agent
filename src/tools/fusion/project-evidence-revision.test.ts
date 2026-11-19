/**
 * Issue #87 item 8: a run's criteria facts are bound to the criterion text
 * they tested. A milestone report reads its runs' facts
 * (`readMilestoneEvidence`), wired as the runtime wires it; a fact for an
 * earlier text of the criterion cannot close the milestone.
 */
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyProjectDecision,
  applyProjectUpdate,
  criteriaById,
  gateVersion,
  readProject,
  withProject,
  type AssignmentRow,
  type ProjectCriterion,
  type ProjectState,
  type ProjectUpdate,
} from "../../session/session-project.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { SessionStore } from "../../session/session-store.js";
import type { ToolContext } from "../tool-registry.js";
import { buildProjectTools, PROJECT_UPDATE_DETAIL, type ProjectToolDeps } from "./project-tools.js";
import { FUSION_RUNS_DIR_NAME } from "./run-checkpoint.js";
import { readMilestoneEvidence, writeRunCriteriaFacts } from "./run-criteria.js";

const NOW = Date.now();
const OFFLINE: ProjectCriterion = { id: "a", text: "Works offline" };
const COLLAB: ProjectCriterion = { id: "a", text: "Supports live collaboration" };
const LEVELS: ProjectCriterion = { id: "b", text: "Has three levels" };

const row = (taskId: string, milestoneId: string): AssignmentRow => ({
  taskId, title: `Task ${taskId}`, milestoneId, worker: "local:a", reviewer: null, reason: "preset",
  basis: "preset", samples: 0, estCostUsd: 0.1, estMs: 1000,
});
const brief = (successCriteria: ProjectCriterion[]): ProjectUpdate => ({
  kind: "brief", brief: { what: "A notes app", users: "Teams", how: "Web", successCriteria }, draftedAfterUntrusted: false,
});
const plan: ProjectUpdate = {
  kind: "plan", milestones: [{ id: "m1", title: "Base", kind: "base" }], rows: [row("t1", "m1")], detail: "compact",
};

let clock = NOW;
function fold(p: ProjectState | undefined, u: ProjectUpdate): ProjectState {
  const r = applyProjectUpdate(p, u, (clock += 1000));
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
}
function approve(p: ProjectState): ProjectState {
  const r = applyProjectDecision(p, { gate: p.gate, version: gateVersion(p)!, verdict: "approve" }, { now: (clock += 1000) });
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
}
/** The brief revised and approved, then the same plan drafted again and approved. */
const revise = (p: ProjectState, criteria: ProjectCriterion[]): ProjectState => approve(fold(approve(fold(p, brief(criteria))), plan));

describe("run facts are bound to the criterion text they tested (issue #87)", () => {
  let state: string;
  let store: SessionStore;
  beforeEach(() => {
    state = mkdtempSync(join(tmpdir(), "evidence-revision-"));
    store = new SessionStore({ dbFile: join(state, "sessions.sqlite") });
  });
  afterEach(() => {
    store.close();
    rmSync(state, { recursive: true, force: true });
  });
  const runs = () => join(state, FUSION_RUNS_DIR_NAME);

  function reopen(p: ProjectState): ProjectState {
    store.save(withProject(createEmptySessionState({ id: "s1", workingDir: "/w" }), p));
    return readProject(store.load("s1")!)!;
  }

  /** A run of m1 whose checks passed both criteria, as the brief then read. */
  function passingRun(p: ProjectState, runId: string): ProjectState {
    writeRunCriteriaFacts(runs(), { runId, sessionId: "s1" }, [
      { taskId: "t1", facts: [{ id: "a", state: "passed", why: "check ok" }, { id: "b", state: "passed", why: "check ok" }] },
    ], criteriaById(p.brief));
    return fold(p, { kind: "milestone_run", id: "m1", runId });
  }

  /** `project.milestone done` for m1, its evidence read as the runtime reads it. */
  async function reportDone(p: ProjectState) {
    const evidence: NonNullable<ProjectToolDeps["milestoneEvidence"]> = (milestone, order, current) =>
      readMilestoneEvidence({ runsDir: runs(), stateDir: state, runIds: milestone.runIds, criteriaOrder: order, ...current });
    const [, , milestone] = buildProjectTools({
      planContext: () => { throw new Error("unused"); },
      outsideContent: () => false,
      milestoneEvidence: evidence,
    });
    const ctx = { workingDir: "/tmp", sessionId: "s1", stepIndex: 0, project: p } as unknown as ToolContext;
    return milestone!.run({ id: "m1", state: "done", summary: "Base done" }, ctx);
  }

  for (const reload of [false, true]) {
    const maybe = (p: ProjectState) => (reload ? reopen(p) : p);

    it(`a pass of the old text cannot close the milestone once the text changed; a fresh run can${reload ? " (across a save and reload)" : ""}`, async () => {
      let p = maybe(passingRun(approve(fold(approve(fold(undefined, brief([OFFLINE, LEVELS]))), plan)), "fr-1"));
      p = maybe(revise(p, [COLLAB, LEVELS]));
      expect(p.milestones[0]).toMatchObject({ state: "in_progress", runIds: ["fr-1"] });
      const refused = await reportDone(p);
      expect(refused.status).toBe("error");
      expect(refused.summary).toMatch(/a unverified/);
      expect(refused.summary).not.toMatch(/b (failed|unverified)/);
      // A fresh passing run, against the revised text, closes it.
      p = maybe(passingRun(p, "fr-2"));
      const done = await reportDone(p);
      expect(done.status).toBe("ok");
      const update = done.details[PROJECT_UPDATE_DETAIL] as Extract<ProjectUpdate, { kind: "milestone" }>;
      expect(update.criteriaFacts).toEqual([{ id: "a", state: "passed", why: "check ok" }, { id: "b", state: "passed", why: "check ok" }]);
      expect(fold(p, update).milestones[0]!.state).toBe("done");
    });

    it(`an unchanged criterion keeps its evidence; a removed id reused for another requirement does not${reload ? " (across a save and reload)" : ""}`, async () => {
      let p = maybe(passingRun(approve(fold(approve(fold(undefined, brief([OFFLINE, LEVELS]))), plan)), "fr-1"));
      // Unchanged texts (a re-approval only): the run still closes it.
      const same = maybe(revise(p, [OFFLINE, LEVELS]));
      expect((await reportDone(same)).status).toBe("ok");
      // Removed, then reused with another text.
      p = maybe(revise(p, [LEVELS]));
      p = maybe(revise(p, [LEVELS, COLLAB]));
      const refused = await reportDone(p);
      expect(refused.status).toBe("error");
      expect(refused.summary).toMatch(/a unverified/);
    });
  }

  it("a run file from before the binding (no text) counts as unverified once the brief was approved after it", () => {
    const at = (ms: number) => ms / 1000;
    writeRunCriteriaFacts(runs(), { runId: "fr-old", sessionId: "s1" }, [{ taskId: "t1", facts: [{ id: "a", state: "passed" }] }]);
    const file = join(runs(), "fr-old", "criteria.json");
    writeFileSync(file, JSON.stringify({ tasks: [{ taskId: "t1", facts: [{ id: "a", state: "passed" }] }] }));
    utimesSync(file, at(NOW - 60_000), at(NOW - 60_000));
    const read = (briefApprovedAt: number) =>
      readMilestoneEvidence({ runsDir: runs(), stateDir: state, runIds: ["fr-old"], criteriaOrder: ["a"], criteria: [COLLAB], briefApprovedAt }).facts;
    expect(read(NOW - 120_000)).toEqual([{ id: "a", state: "passed" }]);
    expect(read(NOW)).toEqual([expect.objectContaining({ id: "a", state: "unverified" })]);
  });
});
