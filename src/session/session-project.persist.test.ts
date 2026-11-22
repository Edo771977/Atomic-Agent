/**
 * Issue #80: project transitions across a real session save and load
 * (SessionStore on a temporary SQLite file), as a restart sees them.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SessionStore } from "./session-store.js";
import { createEmptySessionState } from "./session-state.js";
import {
  applyProjectDecision,
  applyProjectUpdate,
  gateVersion,
  milestoneToApproveNext,
  normalizeProject,
  readProject,
  withProject,
  type AssignmentRow,
  type ProjectCriterionFact,
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
    store.save(withProject(createEmptySessionState({ id: "s1", workingDir: tmp }), project));
    store.close();
    store = new SessionStore({ dbFile: join(tmp, "sessions.sqlite") });
    const loaded = store.load("s1");
    const back = loaded === null ? undefined : readProject(loaded);
    if (back === undefined) throw new Error("project lost on reload");
    return back;
  }

  it("loads every legacy milestone kind from a saved project", () => {
    const kinds = ["base", "ui", "logic", "polish", "other"] as const;
    const project = fold(approve(fold(undefined, brief(["Works offline"]))), {
      kind: "plan",
      milestones: kinds.map((kind) => ({ id: kind, title: kind, kind })),
      rows: kinds.map((kind) => row(kind, kind)),
      detail: "compact",
    });
    expect(reopen(project).milestones.map((milestone) => milestone.kind)).toEqual(kinds);
  });

  it("a criterion id removed and reused for a new requirement carries no pass; the old one stays with its text", () => {
    const offline = { id: "a", text: "works offline" };
    const levels = { id: "lv", text: "Has three levels" };
    const offlinePass: ProjectCriterionFact = {
      id: offline.id,
      state: "passed",
      basis: { kind: "check", checks: [{ index: 1, runId: "run-1", outputHash: "a".repeat(64) }] },
    };
    const collaboration = { id: offline.id, text: "supports live collaboration" };
    let p = approve(fold(approve(fold(undefined, brief([offline, levels]))), plan()));
    p = fold(p, { kind: "milestone_run", id: "a", runId: "run-1" });
    p = approve(fold(p, { kind: "milestone", id: "a", state: "done", summary: "Offline works", criteriaFacts: [offlinePass, { id: "lv", state: "passed" }] }));
    p = reopen(p);
    expect(p.milestones[0]?.criteriaFacts).toContainEqual(offlinePass);
    expect(p.milestones[0]!.state).toBe("reviewed");
    // Remove criterion a, keep the other; persist and reopen.
    p = reopen(approve(fold(p, brief([levels]))));
    // Reuse the id for a different requirement, approved in a later brief.
    p = reopen(approve(fold(p, brief([levels, collaboration]))));
    const m = p.milestones[0]!;
    // The verdict on the kept criterion stands; the reused id has no evidence until it is verified.
    expect(m.state).toBe("reviewed");
    expect(m.criteriaFacts).toEqual([{ id: "lv", state: "passed" }]);
    expect(p.approvedCriteria).toEqual([levels, collaboration]);
    // The earlier pass stays in history, tied to its original text.
    expect(m.history).toEqual([
      expect.objectContaining({
        state: "reviewed",
        cause: "brief-removed",
        runIds: ["run-1"],
        criteriaFacts: [offlinePass],
        criteria: [offline],
      }),
    ]);
  });

  it("approving a revised plan never opens a reset milestone while another runs or awaits a verdict", () => {
    const criteria = [{ id: "c1", text: "Runs" }];
    let p = approve(fold(approve(fold(undefined, brief(criteria))), plan()));
    p = fold(p, { kind: "milestone_run", id: "a", runId: "run-a" });
    p = approve(fold(p, { kind: "milestone", id: "a", state: "done", summary: "A works" }));
    expect(p.milestones.map((m) => m.state)).toEqual(["reviewed", "approved"]);
    p = fold(p, { kind: "milestone_run", id: "b", runId: "run-b" });
    // A's work changes while B runs; persist and reopen, then approve the plan.
    p = reopen(fold(p, plan("Rewrite the storage layer")));
    expect(p.milestones.map((m) => m.state)).toEqual(["planned", "in_progress"]);
    p = reopen(approve(p));
    expect(p.milestones.map((m) => m.state)).toEqual(["planned", "in_progress"]);
    expect(milestoneToApproveNext(p.milestones)).toBeUndefined();
    expect(applyProjectUpdate(p, { kind: "milestone_run", id: "a", runId: "run-a2" }, NOW)).toMatchObject({ ok: false, error: { code: "milestone-not-approved" } });
    // B's result waits for the person: A still waits.
    p = reopen(fold(p, { kind: "milestone", id: "b", state: "done", summary: "B works" }));
    expect(p.milestones.map((m) => m.state)).toEqual(["planned", "done"]);
    expect(p.gate).toEqual({ kind: "milestone", id: "b" });
    expect(milestoneToApproveNext(p.milestones)).toBeUndefined();
    // B reviewed: A is next and can start after reopening.
    p = reopen(approve(p));
    expect(p.milestones.map((m) => m.state)).toEqual(["approved", "reviewed"]);
    p = fold(p, { kind: "milestone_run", id: "a", runId: "run-a2" });
    expect(p.milestones.map((m) => m.state)).toEqual(["in_progress", "reviewed"]);
  });

  it("a project saved before issue #80 that kept a removed criterion's pass does not lend it to a reused id (issue #83)", () => {
    // Built with src/session/session-project.ts at 68e709d: `a` "works offline"
    // passed on m1, then a brief without `a` was approved; that version kept
    // `a`'s fact and pictures and recorded no approved criteria.
    const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "project-saved-before-80.json"), "utf8")) as { project: unknown };
    let p = normalizeProject(fixture.project)!;
    expect(p.milestones[0]!.criteriaFacts).toEqual([{ id: "a", state: "passed" }, { id: "b", state: "passed" }]);
    const collaboration = { id: "a", text: "supports live collaboration" };
    p = reopen(approve(fold(p, brief([{ id: "b", text: "has three levels" }, collaboration]))));
    for (const q of [p, reopen(p)]) {
      const m = q.milestones[0]!;
      // The new `a` has no passing evidence; `b` keeps its own.
      expect(m.state).toBe("reviewed");
      expect(m.criteriaFacts).toEqual([{ id: "b", state: "passed" }]);
      expect((m.attachments ?? []).map((x) => [x.caption, x.criteria])).toEqual([["both", ["b"]], ["levels", ["b"]]]);
      // The old pass is in history, never labelled with the new text.
      const retired = (m.history ?? []).find((h) => (h.criteriaFacts ?? []).some((f) => f.id === "a"));
      expect(retired).toMatchObject({ cause: "brief-removed", criteriaFacts: [{ id: "a", state: "passed" }], unknownCriteria: ["a"], attachmentCount: 1 });
      expect(JSON.stringify(m.history)).not.toContain(collaboration.text);
    }
  });

  it("a project saved before issue #80 with its brief still a draft: approving it retires every criteria fact and picture (issue #83)", () => {
    // Built like the fixture above, at 68e709d, then a brief [b, a: "supports
    // live collaboration"] drafted and saved at its gate: no approved brief,
    // no recorded criteria, nothing to compare against.
    const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "project-saved-before-80-draft-brief.json"), "utf8")) as { project: unknown };
    let p = normalizeProject(fixture.project)!;
    expect(p.brief!.status).toBe("draft");
    expect(p.approvedCriteria).toBeUndefined();
    p = reopen(approve(p));
    for (const q of [p, reopen(p)]) {
      const m = q.milestones[0]!;
      // The verdict stands; no fact or criteria picture of the old results does.
      expect(m.state).toBe("reviewed");
      expect(m.criteriaFacts).toBeUndefined();
      expect(m.attachments).toBeUndefined();
      expect(m.history?.at(-1)).toMatchObject({
        cause: "brief-removed",
        criteriaFacts: [{ id: "a", state: "passed" }, { id: "b", state: "passed" }],
        unknownCriteria: ["a", "b"],
        attachmentCount: 3,
      });
      expect(m.history?.at(-1)?.criteria).toBeUndefined();
      expect(JSON.stringify(m.history)).not.toContain("supports live collaboration");
      expect(q.plan!.evidenceRetired).toEqual(["m1"]);
    }
    // The director's re-plan keeps the note for the plan gate.
    const replanned = fold(p, { kind: "plan", milestones: [{ id: "m1", title: "Base", kind: "base" }, { id: "m2", title: "UI", kind: "ui" }], rows: [row("t1", "m1"), row("t2", "m2")], detail: "compact" });
    expect(replanned.plan!.evidenceRetired).toEqual(["m1"]);
    expect(approve(replanned).plan!.evidenceRetired).toBeUndefined();
  });

  it("a new project's first brief approval retires nothing", () => {
    const p = approve(fold(undefined, brief([{ id: "a", text: "works offline" }])));
    expect(p.milestones).toEqual([]);
    expect(p.plan).toBeUndefined();
    expect(p.approvedCriteria).toEqual([{ id: "a", text: "works offline" }]);
  });
});
