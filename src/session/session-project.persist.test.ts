/**
 * Issue #80: project transitions across a real session save and load
 * (SessionStore on a temporary SQLite file), as a restart sees them.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionStore } from "./session-store.js";
import { createEmptySessionState } from "./session-state.js";
import {
  applyProjectDecision,
  applyProjectUpdate,
  gateVersion,
  readProject,
  withProject,
  type AssignmentRow,
  type ProjectCriterionInput,
  type ProjectState,
  type ProjectUpdate,
} from "./session-project.js";

const NOW = 1_700_000_000_000;

function row(taskId: string, milestoneId: string, title = `Task ${taskId}`): AssignmentRow {
  return {
    taskId, title, milestoneId, worker: "local:a", reviewer: null, reason: "preset",
    basis: "preset", samples: 0, estCostUsd: 0.1, estMs: 1000,
  };
}

const brief = (successCriteria: ProjectCriterionInput[]): ProjectUpdate => ({
  kind: "brief",
  brief: { what: "A notes app", users: "Teams", how: "Web", successCriteria },
  draftedAfterUntrusted: false,
});

const plan = (aTask = "Task t1"): ProjectUpdate => ({
  kind: "plan",
  milestones: [{ id: "a", title: "A", kind: "base" }, { id: "b", title: "B", kind: "ui" }],
  rows: [row("t1", "a", aTask), row("t2", "b")],
  detail: "compact",
});

function fold(p: ProjectState | undefined, u: ProjectUpdate): ProjectState {
  const r = applyProjectUpdate(p, u, NOW);
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
}

function approve(p: ProjectState): ProjectState {
  const r = applyProjectDecision(p, { gate: p.gate, version: gateVersion(p)!, verdict: "approve" }, { now: NOW });
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
}

describe("project state across a session save and load (issue #80)", () => {
  let tmp: string;
  let store: SessionStore;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-project-"));
    store = new SessionStore({ dbFile: join(tmp, "sessions.sqlite") });
  });
  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Save the project on the session, then read it back from disk. */
  function reopen(project: ProjectState): ProjectState {
    store.save(withProject(createEmptySessionState({ id: "s1", workingDir: "/w" }), project));
    const loaded = store.load("s1");
    const back = loaded === null ? undefined : readProject(loaded);
    if (back === undefined) throw new Error("project lost on reload");
    return back;
  }

  it("a criterion id removed and reused for a new requirement carries no pass; the old one stays with its text", () => {
    const offline = { id: "a", text: "works offline" };
    const levels = { id: "lv", text: "Has three levels" };
    let p = approve(fold(approve(fold(undefined, brief([offline, levels]))), plan()));
    p = fold(p, { kind: "milestone_run", id: "a", runId: "run-1" });
    p = approve(fold(p, { kind: "milestone", id: "a", state: "done", summary: "Offline works", criteriaFacts: [{ id: "a", state: "passed" }, { id: "lv", state: "passed" }] }));
    expect(p.milestones[0]!.state).toBe("reviewed");
    // Remove criterion a, keep the other; persist and reopen.
    p = reopen(approve(fold(p, brief([levels]))));
    // Reuse the id for a different requirement.
    p = reopen(fold(p, brief([levels, { id: "a", text: "supports live collaboration" }])));
    const m = p.milestones[0]!;
    expect(m.state).not.toBe("reviewed");
    expect((m.criteriaFacts ?? []).filter((f) => f.id === "a" && f.state === "passed")).toEqual([]);
    expect(m.history).toEqual([
      expect.objectContaining({
        state: "reviewed",
        cause: "brief",
        runIds: ["run-1"],
        criteriaFacts: [{ id: "a", state: "passed" }, { id: "lv", state: "passed" }],
        criteria: [offline, levels],
      }),
    ]);
  });
});
