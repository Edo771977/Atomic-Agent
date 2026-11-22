/**
 * The project backlog's own operations (issue #111): who adds an item,
 * who decides on it, and that neither moves a gate. Items are author
 * content in project.json; promoted and dropped are the person's calls,
 * kept in the state dir's record.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { gateContentHash, stateDirProjectRecords } from "./project-decisions.js";
import { commitProject, createProject, openProject, projectFilePath, type ProjectStoreOptions } from "./project-store.js";
import {
  applyBacklogDecision,
  backlogDecisionFingerprint,
  backlogStateOf,
  nextBacklogId,
  openBacklog,
  openSeeds,
  backlogSourceLabel,
  promotedForPlan,
  staleBacklogCalls,
} from "./project-backlog.js";
import {
  PROJECT_LIMITS,
  applyProjectDecision,
  applyProjectUpdate,
  gateVersion,
  normalizeProject,
  type ProjectState,
  type ProjectUpdate,
} from "./session-project.js";

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "session-with-embedded-project-109.json"), "utf8")) as {
  session: { project: unknown };
};

let folder: string;
let stateDir: string;
let options: ProjectStoreOptions;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "aa-backlog-"));
  stateDir = mkdtempSync(join(tmpdir(), "aa-backlog-state-"));
  options = { stateDir, records: stateDirProjectRecords(stateDir), now: () => 1_700_000_300_000 };
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

/** The fixture with m2 running: nothing waits on the person. */
function running(): ProjectState {
  const p = normalizeProject(fixture.session.project)!;
  return {
    ...p,
    gate: { kind: "none" },
    milestones: p.milestones.map((m) => {
      const { attachments: _a, ...rest } = m;
      return m.id === "m2" ? { ...rest, state: "in_progress" as const } : rest;
    }),
  };
}

const add = (item: Record<string, unknown>): ProjectUpdate => ({ kind: "backlog_add", item: item as never });

function added(project: ProjectState, item: Record<string, unknown>, now = 10): ProjectState {
  const r = applyProjectUpdate(project, add(item), now);
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
}

describe("backlog confirmation fingerprints", () => {
  it("refuses stale content, status and plan adoption before applying a confirmed decision", () => {
    const project = added(running(), { title: "PDF export", note: "Internal only", condition: "When reports ship", source: "director" });
    const item = project.backlog![0]!;
    const expectedFingerprint = backlogDecisionFingerprint(item, "open");
    const decision = { id: item.id, state: "promoted" as const, expectedFingerprint };
    const changed = { ...project, backlog: [{ ...item, note: "Public reports" }] };
    expect(applyBacklogDecision(changed, decision)).toMatchObject({ ok: false, error: { message: expect.stringMatching(/changed since/) } });
    const applied = applyBacklogDecision(project, decision);
    if (!applied.ok) throw new Error(applied.error.message);
    expect(applied.project.backlogStates).toEqual({ b1: "promoted" });
    expect(applyBacklogDecision(applied.project, decision).ok).toBe(false);

    const afterPlan = { ...applied.project, backlogCalls: { b1: { ...applied.project.backlogCalls!.b1!, plannedIn: 4 } } };
    const reopen = { id: item.id, state: "open" as const, expectedFingerprint: backlogDecisionFingerprint(item, "promoted") };
    expect(applyBacklogDecision(afterPlan, reopen).ok).toBe(false);
  });
});

describe("backlog items: adding", () => {
  it("a person's item added during a milestone is in the folder's store and survives closing the chat", () => {
    const created = createProject(folder, running(), options);
    if (!created.ok) throw new Error(created.problem.message);
    const before = created.opened.project;
    const next = added(before, { id: nextBacklogId(before), title: "Export to PDF", note: "asked while m2 ran", source: "director", fromPerson: true, origin: { milestoneId: "m2" } }, 42);
    const w = commitProject(folder, created.opened.stored.id, { revision: created.opened.stored.revision, decisionSeq: created.opened.decisionSeq }, next, options);
    if (!w.ok) throw new Error(w.problem.message);
    // A new process: nothing but the folder and the state dir.
    const reopened = openProject(folder, { stateDir, records: stateDirProjectRecords(stateDir) });
    if (!reopened.ok) throw new Error(reopened.problem.message);
    const p = reopened.opened.project;
    expect(p.backlog).toEqual([{ id: "b1", title: "Export to PDF", note: "asked while m2 ran", source: "director", fromPerson: true, createdAt: 42, origin: { milestoneId: "m2" } }]);
    expect(backlogSourceLabel(p.backlog![0]!)).toBe("director (from your message)");
    expect(backlogStateOf(p, "b1")).toBe("open");
    // No gate moved: nothing reopens, nothing is flagged.
    expect(p.gate).toEqual(before.gate);
    expect(gateVersion(p)).toBe(gateVersion(before));
    expect(p.changedOutside).toBeUndefined();
    for (const gate of [{ kind: "brief" as const }, { kind: "plan" as const }, { kind: "milestone" as const, id: "m2" }]) {
      expect(gateContentHash(p, gate)).toBe(gateContentHash(before, gate));
    }
  });

  it("a director's item is the director's, open, and the plan does not change", () => {
    const before = running();
    const p = added(before, { id: "b1", title: "Dark mode", source: "director", state: "promoted", promoted: true });
    expect(p.backlog?.[0]).toEqual({ id: "b1", title: "Dark mode", source: "director", createdAt: 10 });
    expect(backlogStateOf(p, "b1")).toBe("open");
    expect(p.backlogStates).toBeUndefined();
    expect(p.plan).toEqual(before.plan);
    expect(p.milestones).toEqual(before.milestones);
    expect(promotedForPlan(p)).toEqual([]);
  });

  it("is refused without a brief or after a cancel, and adds at any gate otherwise", () => {
    expect(applyProjectUpdate(undefined, add({ id: "b1", title: "x", source: "director" }), 1).ok).toBe(false);
    const cancelled = applyProjectUpdate({ ...running(), cancelledAt: 5 }, add({ id: "b1", title: "x", source: "director" }), 1);
    expect(!cancelled.ok && cancelled.error.code).toBe("cancelled");
    const atMilestone = applyProjectUpdate({ ...running(), gate: { kind: "milestone", id: "m1" } }, add({ id: "b1", title: "x", source: "director" }), 1);
    expect(atMilestone.ok && atMilestone.project.gate).toEqual({ kind: "milestone", id: "m1" });
  });

  it("enforces the limits: count, text, ids, sources and origins", () => {
    const base = running();
    const refused = (item: Record<string, unknown>, project = base) => {
      const r = applyProjectUpdate(project, add(item), 1);
      return r.ok ? null : r.error.code;
    };
    const full: ProjectState = { ...base, backlog: Array.from({ length: PROJECT_LIMITS.backlog }, (_, i) => ({ id: `b${i + 1}`, title: `Idea ${i + 1}`, source: "director" as const, createdAt: 1 })) };
    expect(refused({ id: "b99", title: "One more", source: "director" }, full)).toBe("invalid");
    expect(nextBacklogId(full)).toBe(`b${PROJECT_LIMITS.backlog + 1}`);
    expect(refused({ id: "b1", title: "", source: "director" })).toBe("invalid");
    expect(refused({ id: "Not An Id", title: "x", source: "director" })).toBe("invalid");
    expect(refused({ id: "b1", title: "x", source: "martian" })).toBe("invalid");
    // Review: a director update cannot claim the person wrote it; it relays with fromPerson.
    expect(refused({ id: "b1", title: "x", source: "person" })).toBe("invalid");
    expect(refused({ id: "b1", title: "x", source: "worker", fromPerson: true, origin: { taskId: "t2" } })).toBe("invalid");
    expect(refused({ id: "b1", title: "x", source: "director", origin: { milestoneId: "m9" } })).toBe("invalid");
    expect(refused({ id: "b1", title: "x", source: "director", origin: { taskId: "t9" } })).toBe("invalid");
    expect(refused({ id: "b1", title: "x", source: "director", origin: { milestoneId: "m1", taskId: "t2" } })).toBe("invalid");
    // A worker's or reviewer's item names the task whose run it came from.
    expect(refused({ id: "b1", title: "x", source: "worker" })).toBe("invalid");
    expect(refused({ id: "b1", title: "x", source: "reviewer", origin: { taskId: "t3" } })).toBe("invalid");
    expect(refused({ id: "b1", title: "x", source: "worker", origin: { taskId: "t2" } })).toBeNull();
    const twice = added(base, { id: "b1", title: "x", source: "director" });
    expect(refused({ id: "b1", title: "y", source: "director" }, twice)).toBe("invalid");
    const long = "x".repeat(2000);
    const clipped = added(base, { id: "b1", title: long, note: long, condition: long, source: "director" });
    expect(clipped.backlog?.[0]?.title.length).toBe(PROJECT_LIMITS.title);
    expect(clipped.backlog?.[0]?.note?.length).toBe(PROJECT_LIMITS.shortText);
    expect(clipped.backlog?.[0]?.condition?.length).toBe(PROJECT_LIMITS.shortText);
  });

  it("a seed is an open item with a condition", () => {
    let p = added(running(), { id: "b1", title: "PDF styles", condition: "when PDF export exists", source: "director" });
    p = added(p, { id: "b2", title: "Dark mode", source: "director", fromPerson: true });
    expect(openSeeds(p).map((b) => b.id)).toEqual(["b1"]);
    expect(openBacklog(p).map((b) => b.id)).toEqual(["b1", "b2"]);
  });

  it("an old project with no backlog reads with an empty one", () => {
    const p = normalizeProject(fixture.session.project)!;
    expect(p.backlog).toBeUndefined();
    expect(openBacklog(p)).toEqual([]);
    expect(nextBacklogId(p)).toBe("b1");
  });
});

describe("backlog items: the person's call", () => {
  it("promoted and dropped are the person's, kept in the record and never in project.json", () => {
    const created = createProject(folder, added(added(running(), { id: "b1", title: "PDF", source: "director" }), { id: "b2", title: "Dark", source: "director" }), options);
    if (!created.ok) throw new Error(created.problem.message);
    const promoted = applyBacklogDecision(created.opened.project, { id: "b1", state: "promoted" });
    if (!promoted.ok) throw new Error(promoted.error.message);
    const dropped = applyBacklogDecision(promoted.project, { id: "b2", state: "dropped" });
    if (!dropped.ok) throw new Error(dropped.error.message);
    // No gate moved.
    expect(dropped.project.gate).toEqual(created.opened.project.gate);
    expect(gateVersion(dropped.project)).toBe(gateVersion(created.opened.project));
    const w = commitProject(folder, created.opened.stored.id, { revision: created.opened.stored.revision, decisionSeq: created.opened.decisionSeq }, dropped.project, options);
    if (!w.ok) throw new Error(w.problem.message);
    const raw = readFileSync(projectFilePath(folder), "utf8");
    expect(raw).not.toContain("promoted");
    expect(raw).not.toContain("dropped");
    // A shell edit of project.json cannot undo or forge the calls.
    const json = JSON.parse(raw);
    json.project.backlog[0].state = "dropped";
    json.project.backlogStates = { b1: "dropped", b2: "promoted" };
    writeFileSync(projectFilePath(folder), JSON.stringify(json));
    const reopened = openProject(folder, options);
    if (!reopened.ok) throw new Error(reopened.problem.message);
    expect(backlogStateOf(reopened.opened.project, "b1")).toBe("promoted");
    expect(backlogStateOf(reopened.opened.project, "b2")).toBe("dropped");
    expect(openBacklog(reopened.opened.project)).toEqual([]);
    expect(promotedForPlan(reopened.opened.project).map((b) => b.id)).toEqual(["b1"]);
  });

  it("refuses an unknown item or state, and can reopen an item", () => {
    const p = added(running(), { id: "b1", title: "PDF", source: "director" });
    const unknown = applyBacklogDecision(p, { id: "b9", state: "promoted" });
    expect(!unknown.ok && unknown.error.code).toBe("invalid");
    const bad = applyBacklogDecision(p, { id: "b1", state: "kept" as never });
    expect(!bad.ok && bad.error.code).toBe("invalid");
    expect(applyBacklogDecision(undefined, { id: "b1", state: "dropped" }).ok).toBe(false);
    const dropped = applyBacklogDecision(p, { id: "b1", state: "dropped" });
    if (!dropped.ok) throw new Error(dropped.error.message);
    const reopened = applyBacklogDecision(dropped.project, { id: "b1", state: "open" });
    expect(reopened.ok && reopened.project.backlogStates).toBeUndefined();
  });

  it("a promoted item waits for the next plan the person approves, which takes it in", () => {
    const p = added(running(), { id: "b1", title: "PDF", source: "director" });
    const promoted = applyBacklogDecision(p, { id: "b1", state: "promoted" });
    if (!promoted.ok) throw new Error(promoted.error.message);
    // The director re-plans with the item as a new milestone; the plan gate opens.
    const before = promoted.project;
    const rows = before.plan!.rows;
    const draft = applyProjectUpdate(before, {
      kind: "plan",
      milestones: [...before.milestones.map((m) => ({ id: m.id, title: m.title, kind: m.kind })), { id: "m4", title: "PDF export", kind: "other" }],
      // Issue #146: the task that takes the item in cites it, or the plan is not approved.
      rows: [...rows, { ...rows[0]!, taskId: "t4", title: "PDF export", milestoneId: "m4", backlog: ["b1"] }],
      detail: "compact",
    }, 20);
    if (!draft.ok) throw new Error(draft.error.message);
    expect(draft.project.gate).toEqual({ kind: "plan" });
    expect(promotedForPlan(draft.project).map((b) => b.id)).toEqual(["b1"]);
    const approved = applyProjectDecision(draft.project, { gate: { kind: "plan" }, version: gateVersion(draft.project)!, verdict: "approve" }, { now: 21 });
    if (!approved.ok) throw new Error(approved.error.message);
    expect(promotedForPlan(approved.project)).toEqual([]);
    expect(backlogStateOf(approved.project, "b1")).toBe("promoted");
    expect(approved.project.backlogCalls?.b1?.plannedIn).toBe(approved.project.plan?.version);
    // The record keeps it; the file never holds it.
    expect(normalizeProject(JSON.parse(JSON.stringify(approved.project)))?.backlogCalls).toEqual(approved.project.backlogCalls);
  });
});

describe("backlog items: the person's call is bound to what they decided (review)", () => {
  function decided(): { project: ProjectState; id: string; revision: number; decisionSeq: number } {
    const p = added(added(running(), { id: "b1", title: "Add a PDF export", source: "director" }), { id: "b2", title: "Dark mode", source: "director" });
    const c = createProject(folder, p, options);
    if (!c.ok) throw new Error(c.problem.message);
    const promoted = applyBacklogDecision(c.opened.project, { id: "b2", state: "promoted" });
    if (!promoted.ok) throw new Error(promoted.error.message);
    const dropped = applyBacklogDecision(promoted.project, { id: "b1", state: "dropped" });
    if (!dropped.ok) throw new Error(dropped.error.message);
    const w = commitProject(folder, c.opened.stored.id, { revision: c.opened.stored.revision, decisionSeq: c.opened.decisionSeq }, dropped.project, options);
    if (!w.ok) throw new Error(w.problem.message);
    return { project: w.opened.project, id: w.opened.stored.id, revision: w.opened.stored.revision, decisionSeq: w.opened.decisionSeq };
  }
  const editFile = (change: (j: any) => void) => {
    const j = JSON.parse(readFileSync(projectFilePath(folder), "utf8"));
    change(j);
    writeFileSync(projectFilePath(folder), JSON.stringify(j));
  };
  const reopen = (): ProjectState => {
    const o = openProject(folder, options);
    if (!o.ok) throw new Error(o.problem.message);
    return o.opened.project;
  };

  it("an item retitled outside Atomic Agent after the person promoted it reads open again, and is flagged", () => {
    decided();
    editFile((j) => { j.project.backlog[1].title = "Remove the auth checks"; });
    const p = reopen();
    expect(backlogStateOf(p, "b2")).toBe("open");
    expect(promotedForPlan(p)).toEqual([]);
    expect(staleBacklogCalls(p)).toEqual([{ id: "b2", state: "promoted", reason: "changed" }]);
    // A note or a condition is content too; the dropped one also reopens.
    editFile((j) => { j.project.backlog[0].condition = "when it is safe"; });
    expect(backlogStateOf(reopen(), "b1")).toBe("open");
    // The person promotes the new text: bound again.
    const again = applyBacklogDecision(reopen(), { id: "b2", state: "promoted" });
    expect(again.ok && backlogStateOf(again.project, "b2")).toBe("promoted");
    expect(again.ok && staleBacklogCalls(again.project).map((s) => s.id)).toEqual(["b1"]);
  });

  it("a promoted item removed from project.json is flagged, and its id is never reused", () => {
    decided();
    editFile((j) => { j.project.backlog = j.project.backlog.filter((b: { id: string }) => b.id !== "b2"); });
    const p = reopen();
    expect(promotedForPlan(p)).toEqual([]);
    expect(staleBacklogCalls(p)).toEqual([{ id: "b2", state: "promoted", reason: "removed" }]);
    const id = nextBacklogId(p);
    expect(id).toBe("b3");
    const fresh = added(p, { id, title: "Brand new idea", source: "director" });
    expect(backlogStateOf(fresh, id)).toBe("open");
    // A decided id stays reserved even with its item gone.
    const reuse = applyProjectUpdate(p, add({ id: "b2", title: "Brand new idea", source: "director" }), 1);
    expect(!reuse.ok && reuse.error.message).toMatch(/b2.*used/);
    // Taking the call back clears the flag.
    const cleared = applyBacklogDecision(p, { id: "b2", state: "open" });
    expect(cleared.ok && staleBacklogCalls(cleared.project)).toEqual([]);
    // A missing item with no call cannot be decided.
    expect(applyBacklogDecision(p, { id: "b9", state: "open" }).ok).toBe(false);
  });

  it("an item re-added by hand under a decided id inherits nothing", () => {
    decided();
    editFile((j) => {
      j.project.backlog = j.project.backlog.filter((b: { id: string }) => b.id !== "b2");
      j.project.backlog.push({ id: "b2", title: "Something else", source: "person", createdAt: 9 });
    });
    const p = reopen();
    expect(backlogStateOf(p, "b2")).toBe("open");
    expect(staleBacklogCalls(p)).toEqual([{ id: "b2", state: "promoted", reason: "changed" }]);
  });
});

describe("backlog items: the cap counts live items (review)", () => {
  it("dropped items do not fill the backlog; the cap names open and promoted items", () => {
    let p = running();
    for (let i = 1; i <= PROJECT_LIMITS.backlog; i++) p = added(p, { id: `b${i}`, title: `x${i}`, source: "director" });
    const full = applyProjectUpdate(p, add({ id: nextBacklogId(p), title: "one more", source: "director" }), 1);
    expect(!full.ok && full.error.message).toMatch(new RegExp(`${PROJECT_LIMITS.backlog} open or promoted items`));
    for (let i = 1; i <= PROJECT_LIMITS.backlog; i++) {
      const r = applyBacklogDecision(p, { id: `b${i}`, state: "dropped" });
      if (!r.ok) throw new Error(r.error.message);
      p = r.project;
    }
    const after = applyProjectUpdate(p, add({ id: nextBacklogId(p), title: "y", source: "director" }), 1);
    expect(after.ok).toBe(true);
    expect(after.ok && openBacklog(after.project).map((b) => b.id)).toEqual([`b${PROJECT_LIMITS.backlog + 1}`]);
  });
});

describe("backlog items: no call on a cancelled project (review)", () => {
  it("refuses promote, drop and reopen after a cancel", () => {
    const p = { ...added(running(), { id: "b1", title: "PDF", source: "director" }), cancelledAt: 9 };
    for (const state of ["promoted", "dropped", "open"] as const) {
      const r = applyBacklogDecision(p, { id: "b1", state });
      expect(!r.ok && r.error.code, state).toBe("no-project");
    }
  });
});
