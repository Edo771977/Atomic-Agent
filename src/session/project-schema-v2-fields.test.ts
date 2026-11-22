/**
 * Schema v2's optional project fields (issues #111, #112, #113): the
 * brief's `deliverable` and `decisions`, the plan rows' `decisions`, the
 * `backlog`. Stored, validated, capped and hashed only; the person's
 * calls on them (a decision's status, a backlog item promoted or dropped)
 * live in the record, never in project.json.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { gateContentHash, memoryProjectRecords, stateDirProjectRecords } from "./project-decisions.js";
import { commitProject, createProject, openProject, projectFilePath, type ProjectStoreOptions } from "./project-store.js";
import {
  PROJECT_LIMITS,
  applyProjectUpdate,
  gateVersion,
  normalizeProject,
  type ProjectBacklogItem,
  type ProjectState,
} from "./session-project.js";

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "session-with-embedded-project-109.json"), "utf8")) as {
  session: { project: unknown };
};

let folder: string;
let stateDir: string;
let options: ProjectStoreOptions;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "aa-v2-"));
  stateDir = mkdtempSync(join(tmpdir(), "aa-v2-state-"));
  options = { stateDir, records: stateDirProjectRecords(stateDir), now: () => 1_700_000_300_000 };
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

const item = (id: string, extra: Partial<ProjectBacklogItem> = {}): ProjectBacklogItem => ({ id, title: `Idea ${id}`, source: "director", createdAt: 5, ...extra });

/** The fixture with nothing open (m2 running), with the v2 fields set. */
function withFields(): ProjectState {
  const p = normalizeProject(fixture.session.project)!;
  return {
    ...p,
    gate: { kind: "none" },
    brief: { ...p.brief!, deliverable: "game", decisions: [{ id: "d1", text: "Use SQLite, not Postgres" }, { id: "d2", text: "No new dependencies" }] },
    plan: { ...p.plan!, rows: p.plan!.rows.map((r, i) => (i === 0 ? { ...r, decisions: ["d1"] } : r)) },
    milestones: p.milestones.map((m) => {
      const { attachments: _a, ...rest } = m;
      return m.id === "m2" ? { ...rest, state: "in_progress" as const } : rest;
    }),
    backlog: [item("b1", { note: "after the export", condition: "when PDF export exists", origin: { milestoneId: "m1", taskId: "t1" } }), item("b2", { source: "person" })],
    decisionStatus: { d2: "deferred" },
    backlogStates: { b2: "promoted" },
  };
}

function edit(change: (json: any) => void): void {
  const file = projectFilePath(folder);
  const json = JSON.parse(readFileSync(file, "utf8"));
  change(json);
  writeFileSync(file, JSON.stringify(json));
}

function open(): ProjectState {
  const r = openProject(folder, options);
  if (!r.ok) throw new Error(r.problem.message);
  return r.opened.project;
}

describe("schema v2 fields: shape, caps, validation", () => {
  it("a stored project keeps the fields and reads back the same", () => {
    const p = withFields();
    expect(normalizeProject(JSON.parse(JSON.stringify(p)))).toEqual(p);
  });

  it("a stored project caps and clips them, dropping malformed entries (not the project)", () => {
    const p = withFields();
    const long = "x".repeat(1000);
    const raw = JSON.parse(JSON.stringify(p));
    raw.brief.deliverable = "banana";
    raw.brief.decisions = [
      ...Array.from({ length: 30 }, (_, i) => ({ id: `d${i + 1}`, text: i === 0 ? long : `Decision ${i + 1}` })),
    ];
    raw.brief.decisions.splice(1, 0, { id: "BAD ID", text: "x" }, { id: "d1", text: "repeat" }, "plain text");
    raw.backlog = [
      ...Array.from({ length: PROJECT_LIMITS.backlogStored + 18 }, (_, i) => item(`b${i + 1}`, i === 0 ? { title: long, note: long, condition: long } : {})),
    ];
    raw.backlog.splice(1, 0, { id: "b-bad", title: "", source: "director", createdAt: 1 }, { id: "b-src", title: "x", source: "martian", createdAt: 1 });
    raw.decisionStatus = { d1: "informational", d2: "bogus", "BAD ID": "deferred" };
    raw.backlogStates = { b1: "dropped", b2: "open", b3: 7 };
    const read = normalizeProject(raw)!;
    expect(read).toBeDefined();
    expect(read.brief?.deliverable).toBeUndefined();
    expect(read.brief?.decisions).toHaveLength(PROJECT_LIMITS.decisions);
    expect(read.brief?.decisions?.[0]?.text.length).toBe(PROJECT_LIMITS.shortText);
    expect(read.brief?.decisions?.map((d) => d.id).slice(0, 3)).toEqual(["d1", "d2", "d3"]);
    expect(read.backlog).toHaveLength(PROJECT_LIMITS.backlogStored);
    expect(read.backlog?.[0]?.title.length).toBe(PROJECT_LIMITS.title);
    expect(read.backlog?.[0]?.note?.length).toBe(PROJECT_LIMITS.shortText);
    expect(read.backlog?.some((b) => b.id === "b-bad" || b.id === "b-src")).toBe(false);
    expect(read.decisionStatus).toEqual({ d1: "informational" });
    expect(read.backlogStates).toEqual({ b1: "dropped" });
  });

  it("a plan row's decisions are ids; a malformed list makes the row malformed", () => {
    const raw = JSON.parse(JSON.stringify(withFields()));
    raw.plan.rows[0].decisions = ["Not An Id"];
    expect(normalizeProject(raw)).toBeUndefined();
  });

  it("a director's brief draft is validated strictly", () => {
    const p = normalizeProject(fixture.session.project)!;
    const base = { ...p, gate: { kind: "none" as const }, milestones: p.milestones.map((m) => ({ ...m, state: "planned" as const })) };
    const brief = { what: "A puzzle", users: "Players", how: "Canvas", successCriteria: ["Runs offline"] };
    const draft = (extra: Record<string, unknown>) => applyProjectUpdate(base, { kind: "brief", brief: { ...brief, ...extra } as never, draftedAfterUntrusted: false }, 1);
    const ok = draft({ deliverable: "document", decisions: [{ id: "d1", text: "Formal Italian" }] });
    expect(ok.ok && ok.project.brief?.deliverable).toBe("document");
    expect(ok.ok && ok.project.brief?.decisions).toEqual([{ id: "d1", text: "Formal Italian" }]);
    const bad = [
      draft({ deliverable: "banana" }),
      draft({ decisions: [{ id: "Bad Id", text: "x" }] }),
      draft({ decisions: [{ id: "d1", text: "x" }, { id: "d1", text: "y" }] }),
      draft({ decisions: [{ id: "d1", text: "" }] }),
      draft({ decisions: Array.from({ length: PROJECT_LIMITS.decisions + 1 }, (_, i) => ({ id: `d${i}`, text: "x" })) }),
    ];
    for (const r of bad) expect(!r.ok && r.error.code).toBe("invalid");
  });

  it("brief and plan updates carry the backlog and the person's calls through", () => {
    const p = withFields();
    const plan = applyProjectUpdate({ ...p, gate: { kind: "none" } }, {
      kind: "plan",
      milestones: p.milestones.map((m) => ({ id: m.id, title: m.title, kind: m.kind })),
      rows: p.plan!.rows,
      detail: "compact",
    }, 2);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.project.backlog).toEqual(p.backlog);
    expect(plan.project.decisionStatus).toEqual(p.decisionStatus);
    expect(plan.project.backlogStates).toEqual(p.backlogStates);
    expect(plan.project.plan?.rows[0]?.decisions).toEqual(["d1"]);
    const brief = applyProjectUpdate(p, { kind: "brief", brief: { what: "x", users: "y", how: "z", successCriteria: ["Runs offline"] }, draftedAfterUntrusted: false }, 3);
    expect(brief.ok && brief.project.backlog).toEqual(p.backlog);
    expect(brief.ok && brief.project.backlogStates).toEqual(p.backlogStates);
  });
});

describe("schema v2 fields: ownership and hashing", () => {
  it("content goes to project.json; the person's calls stay in the record", () => {
    const c = createProject(folder, withFields(), options);
    if (!c.ok) throw new Error(c.problem.message);
    const raw = JSON.parse(readFileSync(projectFilePath(folder), "utf8"));
    expect(raw.project.brief.deliverable).toBe("game");
    expect(raw.project.brief.decisions).toHaveLength(2);
    expect(raw.project.plan.rows[0].decisions).toEqual(["d1"]);
    expect(raw.project.backlog.map((b: { id: string }) => b.id)).toEqual(["b1", "b2"]);
    expect(raw.project.decisionStatus).toBeUndefined();
    expect(raw.project.backlogStates).toBeUndefined();
    const p = open();
    expect(p.decisionStatus).toEqual({ d2: "deferred" });
    expect(p.backlogStates).toEqual({ b2: "promoted" });
    expect(p.brief?.decisions).toEqual(withFields().brief?.decisions);
  });

  it("a decision's status or a backlog item's promotion written into project.json does nothing", () => {
    createProject(folder, withFields(), options);
    edit((j) => {
      j.project.decisionStatus = { d1: "retired", d2: "active" };
      j.project.backlogStates = { b1: "promoted", b2: "dropped" };
    });
    const p = open();
    expect(p.decisionStatus).toEqual({ d2: "deferred" });
    expect(p.backlogStates).toEqual({ b2: "promoted" });
    expect(p.gate).toEqual({ kind: "none" });
    expect(p.changedOutside).toBeUndefined();
  });

  it("nested status fields in author entries cannot decide anything, with or without a record", () => {
    createProject(folder, withFields(), options);
    edit((j) => {
      j.project.brief.decisions[0].status = "retired";
      j.project.backlog[0].state = "promoted";
      j.project.backlog[0].promoted = true;
      j.project.decisionStatus = { d1: "retired" };
      j.project.backlogStates = { b1: "promoted" };
    });
    expect(open().decisionStatus).toEqual({ d2: "deferred" });
    expect(open().backlogStates).toEqual({ b2: "promoted" });
    const fresh = openProject(folder, { ...options, records: memoryProjectRecords() });
    expect(fresh.ok && fresh.opened.project.decisionStatus).toBeUndefined();
    expect(fresh.ok && fresh.opened.project.backlogStates).toBeUndefined();
  });

  it("plan check edits reopen the plan, recompute results and cannot forge a passing record", () => {
    const p = withFields();
    p.plan!.rows[0]!.checks = [{ cmd: "node check.cjs", checks: ["exit 0"], negative: { stdin: "bad" } }];
    const created = createProject(folder, p, options);
    if (!created.ok) throw new Error(created.problem.message);
    edit((j) => {
      expect(j.project.plan.checkResults).toBeUndefined();
      j.project.plan.rows[0].checks[0] = { cmd: "echo ok" };
      j.project.plan.checkResults = [{ dimension: "check-lint", verdict: "pass", detail: "forged", taskIds: [] }];
    });
    const changed = open();
    expect(changed.gate).toEqual({ kind: "plan" });
    expect(changed.changedOutside).toEqual(["plan"]);
    expect(changed.plan?.checkResults).toContainEqual(expect.objectContaining({ dimension: "check-lint", verdict: "fail" }));
    const opened = openProject(folder, options);
    if (!opened.ok) throw new Error(opened.problem.message);
    const saved = commitProject(folder, opened.opened.stored.id, { revision: opened.opened.stored.revision, decisionSeq: opened.opened.decisionSeq }, changed, options);
    expect(saved.ok).toBe(true);
    const record = options.records.read(folder);
    expect(record.ok && record.record?.state.plan?.checkResults).toEqual(changed.plan?.checkResults);
    expect(JSON.parse(readFileSync(projectFilePath(folder), "utf8")).project.plan.checkResults).toBeUndefined();
  });

  it("a backlog edit in project.json is taken and reopens no gate", () => {
    const c = createProject(folder, withFields(), options);
    if (!c.ok) throw new Error(c.problem.message);
    const before = c.opened.project;
    edit((j) => {
      j.project.backlog.push({ id: "b3", title: "Dark mode", source: "person", createdAt: 9 });
      j.project.backlog[0].title = "Idea one, reworded";
    });
    const p = open();
    expect(p.backlog?.map((b) => b.title)).toEqual(["Idea one, reworded", "Idea b2", "Dark mode"]);
    expect(p.gate).toEqual(before.gate);
    expect(gateVersion(p)).toBe(gateVersion(before));
    expect(p.brief?.status).toBe("approved");
    expect(p.plan?.status).toBe("approved");
    expect(p.changedOutside).toBeUndefined();
    // Not covered by the brief, plan or milestone hashes.
    for (const gate of [{ kind: "brief" as const }, { kind: "plan" as const }, { kind: "milestone" as const, id: "m2" }, { kind: "none" as const }]) {
      expect(gateContentHash(p, gate)).toBe(gateContentHash(before, gate));
    }
    // The next write keeps it.
    const opened = openProject(folder, options);
    if (!opened.ok) throw new Error(opened.problem.message);
    const w = commitProject(folder, opened.opened.stored.id, { revision: opened.opened.stored.revision, decisionSeq: opened.opened.decisionSeq }, opened.opened.project, options);
    expect(w.ok && w.opened.project.backlog?.length).toBe(3);
  });

  it("a decision's text edit reopens the brief gate; its hash covers decisions and deliverable", () => {
    const c = createProject(folder, withFields(), options);
    if (!c.ok) throw new Error(c.problem.message);
    const before = c.opened.project;
    edit((j) => { j.project.brief.decisions[0].text = "Use Postgres"; });
    const p = open();
    expect(p.gate).toEqual({ kind: "brief" });
    expect(p.brief?.status).toBe("draft");
    expect(p.changedOutside).toEqual(["brief"]);
    expect(gateContentHash(p, { kind: "brief" })).not.toBe(gateContentHash(before, { kind: "brief" }));
    const otherDeliverable: ProjectState = { ...before, brief: { ...before.brief!, deliverable: "document" } };
    expect(gateContentHash(otherDeliverable, { kind: "brief" })).not.toBe(gateContentHash(before, { kind: "brief" }));
    const otherRowDecisions: ProjectState = { ...before, plan: { ...before.plan!, rows: before.plan!.rows.map((r) => ({ ...r, decisions: ["d2"] })) } };
    expect(gateContentHash(otherRowDecisions, { kind: "plan" })).not.toBe(gateContentHash(before, { kind: "plan" }));
  });
});

describe("schema v2 fields: the person's brief edit", () => {
  it("keeps the deliverable and decisions it does not change", async () => {
    const { applyProjectDecision } = await import("./session-project.js");
    const p = withFields();
    const draft = applyProjectUpdate(p, { kind: "brief", brief: { what: "x", users: "y", how: "z", deliverable: "game", decisions: p.brief!.decisions!, successCriteria: ["Runs offline"] }, draftedAfterUntrusted: false }, 3);
    if (!draft.ok) throw new Error(draft.error.message);
    const r = applyProjectDecision(draft.project, { gate: { kind: "brief" }, version: gateVersion(draft.project)!, verdict: "edit", edits: { brief: { how: "Canvas" } } }, { now: 4 });
    expect(r.ok && r.project.brief?.deliverable).toBe("game");
    expect(r.ok && r.project.brief?.decisions).toEqual(p.brief!.decisions);
  });
});
