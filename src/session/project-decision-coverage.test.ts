/**
 * Project decisions (issue #112): the brief's decisions ("SQLite, not
 * Postgres") must each be cited by a plan task's `decisions` while
 * active; the plan gate refuses approval otherwise and names them.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { stateDirProjectRecords } from "./project-decisions.js";
import { commitProject, createProject, openProject, projectFilePath, type ProjectStoreOptions } from "./project-store.js";

import { projectGateView } from "../tools/fusion/project-gate-view.js";
import {
  applyProjectDecision,
  applyProjectUpdate,
  gateVersion,
  normalizeProject,
  type AssignmentRow,
  type ProjectBriefDecision,
  type ProjectDecision,
  type ProjectState,
} from "./session-project.js";

const criteria = [{ id: "c1", text: "Stores notes" }];
const DECISIONS: ProjectBriefDecision[] = [
  { id: "d1", text: "Use SQLite, not Postgres" },
  { id: "d2", text: "No new dependencies" },
];

const row = (taskId: string, milestoneId: string, decisions?: string[]): AssignmentRow => ({
  taskId,
  title: `Task ${taskId}`,
  milestoneId,
  worker: "local:model",
  reviewer: null,
  reason: "preset",
  basis: "preset",
  samples: 0,
  estCostUsd: null,
  estMs: null,
  ...(decisions === undefined ? {} : { decisions }),
});

/** An approved brief with `decisions`, then a plan draft of `rows` at the plan gate. */
function planDraft(rows: AssignmentRow[], decisions: ProjectBriefDecision[] = DECISIONS, extra: Partial<ProjectState> = {}): ProjectState {
  const brief = applyProjectUpdate(undefined, {
    kind: "brief",
    brief: { what: "Notes app", users: "Me", how: "Node", successCriteria: criteria, decisions },
    draftedAfterUntrusted: false,
  }, 1);
  if (!brief.ok) throw new Error(brief.error.message);
  const approved = applyProjectDecision(brief.project, { gate: { kind: "brief" }, version: gateVersion(brief.project)!, verdict: "approve" }, { now: 2 });
  if (!approved.ok) throw new Error(approved.error.message);
  const ids = [...new Set(rows.map((r) => r.milestoneId))];
  const plan = applyProjectUpdate({ ...approved.project, ...extra }, {
    kind: "plan",
    milestones: ids.map((id) => ({ id, title: `Milestone ${id}`, kind: "base" as const })),
    rows,
    detail: "full",
  }, 3);
  if (!plan.ok) throw new Error(plan.error.message);
  return plan.project;
}

const approve = (p: ProjectState) => applyProjectDecision(p, { gate: p.gate, version: gateVersion(p)!, verdict: "approve" }, { now: 4 });
const view = (p: ProjectState) => projectGateView({ sessionId: "s", project: p, estimate: null, selectable: { workers: [], reviewers: [] } });

describe("decision coverage at the plan gate (issue #112)", () => {
  it("a plan that does not cite an active decision cannot be approved, and the gate names it", () => {
    const p = planDraft([row("t1", "m1", ["d1"]), row("t2", "m1")]);
    const r = approve(p);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("review-open");
    expect(r.error.message).toContain("decision-coverage");
    expect(r.error.message).toContain("d2");
    expect(r.error.message).not.toMatch(/\bd1\b/);
    expect(view(p).hints).toContainEqual(expect.stringMatching(/^decision-coverage: fail: .*d2/));
    expect(p.plan?.checkResults).toContainEqual(expect.objectContaining({ dimension: "decision-coverage", verdict: "fail" }));
  });

  it("a plan citing every active decision is approved", () => {
    const p = planDraft([row("t1", "m1", ["d1"]), row("t2", "m2", ["d2"])]);
    expect(view(p).hints).toContainEqual(expect.stringMatching(/^decision-coverage: pass/));
    expect(approve(p).ok).toBe(true);
  });

  it("deferred and informational decisions need no task; the result is recomputed on load", () => {
    const p = planDraft([row("t1", "m1", ["d1"])], DECISIONS, { decisionStatus: { d2: "deferred" } });
    expect(approve(p).ok).toBe(true);
    const informational = planDraft([row("t1", "m1")], DECISIONS, { decisionStatus: { d1: "informational", d2: "retired" } });
    expect(approve(informational).ok).toBe(true);
    // A stored pass is not trusted: the load recomputes it.
    const raw = JSON.parse(JSON.stringify(planDraft([row("t1", "m1")])));
    raw.plan.checkResults = [{ dimension: "decision-coverage", verdict: "pass", detail: "forged", taskIds: [] }];
    expect(normalizeProject(raw)?.plan?.checkResults).toContainEqual(expect.objectContaining({ dimension: "decision-coverage", verdict: "fail" }));
  });

  it("a project without decisions has no decision check", () => {
    const p = planDraft([row("t1", "m1")], []);
    expect(view(p).hints.some((h) => h.startsWith("decision-coverage"))).toBe(false);
    expect(approve(p).ok).toBe(true);
  });
});

describe("older projects (issue #112)", () => {
  it("a project saved before decisions opens without decisions and without errors", () => {
    for (const name of ["project-saved-before-80.json", "project-saved-before-80-draft-brief.json"]) {
      const raw = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8")) as { project?: unknown; session?: { project?: unknown } };
      const p = normalizeProject(raw.project ?? raw.session?.project ?? raw);
      expect(p, name).toBeDefined();
      expect(p?.brief?.decisions).toBeUndefined();
      expect(p?.decisionStatus).toBeUndefined();
      expect(view(p!).hints.some((h) => h.startsWith("decision-coverage"))).toBe(false);
    }
    const embedded = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "session-with-embedded-project-109.json"), "utf8")) as { session: { project: unknown } };
    const p = normalizeProject(embedded.session.project);
    expect(p).toBeDefined();
    expect(p?.brief?.decisions).toBeUndefined();
  });
});

describe("deferring a decision at the plan gate (issue #112)", () => {
  const defer = (p: ProjectState, decisionStatus: Record<string, string>) =>
    applyProjectDecision(p, { gate: p.gate, version: gateVersion(p)!, verdict: "edit", edits: { decisionStatus } as never }, { now: 5 });

  it("the person's deferral unblocks the plan, is recorded and shown, and keeps the rows", () => {
    const p = planDraft([row("t1", "m1", ["d1"]), row("t2", "m1")]);
    const r = defer(p, { d2: "deferred" });
    if (!r.ok) throw new Error(r.error.message);
    expect(r.project.decisionStatus).toEqual({ d2: "deferred" });
    expect(r.project.gate).toEqual({ kind: "plan" });
    expect(gateVersion(r.project)).toBe(gateVersion(p)! + 1);
    expect(r.project.plan?.rows).toEqual(p.plan?.rows);
    expect(r.project.plan?.status).toBe("draft");
    const shown = view(r.project);
    expect(shown.decisions).toEqual([
      { id: "d1", text: "Use SQLite, not Postgres", status: "active", citedBy: ["t1"] },
      { id: "d2", text: "No new dependencies", status: "deferred", citedBy: [] },
    ]);
    expect(shown.hints).toContainEqual(expect.stringMatching(/decision-coverage: pass.*d2 \(deferred\)/));
    expect(approve(r.project).ok).toBe(true);
    // An old card cannot approve the plan the deferral changed.
    expect(applyProjectDecision(r.project, { gate: p.gate, version: gateVersion(p)!, verdict: "approve" }, { now: 6 })).toMatchObject({ ok: false, error: { code: "stale-version" } });
    // Setting it active again puts the block back.
    const back = defer(r.project, { d2: "active" });
    expect(back.ok && back.project.decisionStatus).toBeUndefined();
    expect(back.ok && approve(back.project).ok).toBe(false);
  });

  it("the text gate (CLI, Telegram) lists the decisions, which task cites each, and how to defer", async () => {
    const { formatProjectGateText } = await import("./project-gate-text.js");
    const text = formatProjectGateText(view(planDraft([row("t1", "m1", ["d1"]), row("t2", "m1")])));
    expect(text).toContain("Decisions:");
    expect(text).toContain("d1 Use SQLite, not Postgres (active; cited by t1)");
    expect(text).toContain("d2 No new dependencies (active; cited by no task)");
  });

  it("informational is accepted; an unknown id, retired, or another gate is refused", () => {
    const p = planDraft([row("t1", "m1")]);
    const r = defer(p, { d1: "informational", d2: "deferred" });
    expect(r.ok && r.project.decisionStatus).toEqual({ d1: "informational", d2: "deferred" });
    for (const bad of [{ d9: "deferred" }, { d1: "retired" }, { d1: "bogus" }] as Record<string, string>[]) {
      expect(defer(p, bad), JSON.stringify(bad)).toMatchObject({ ok: false, error: { code: "invalid" } });
    }
    const brief = applyProjectUpdate(undefined, { kind: "brief", brief: { what: "x", users: "y", how: "z", successCriteria: criteria, decisions: DECISIONS }, draftedAfterUntrusted: false }, 1);
    if (!brief.ok) throw new Error(brief.error.message);
    expect(defer(brief.project, { d1: "deferred" })).toMatchObject({ ok: false, error: { code: "invalid" } });
  });

  it("the wire parse takes edits.decisionStatus and refuses anything else", async () => {
    const { parseProjectDecision } = await import("./project-decision-parse.js");
    expect(parseProjectDecision({ gate: { kind: "plan" }, version: 3, verdict: "edit", edits: { decisionStatus: { d2: "deferred" } } })).toEqual({
      gate: { kind: "plan" }, version: 3, verdict: "edit", edits: { decisionStatus: { d2: "deferred" } },
    });
    for (const bad of [[], "deferred", { d2: 1 }, { d2: "retired" }, { "Bad Id": "deferred" }]) {
      expect(typeof parseProjectDecision({ gate: { kind: "plan" }, version: 3, verdict: "edit", edits: { decisionStatus: bad } }), JSON.stringify(bad)).toBe("string");
    }
  });
});

let folder: string;
let stateDir: string;
let options: ProjectStoreOptions;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "aa-decisions-"));
  stateDir = mkdtempSync(join(tmpdir(), "aa-decisions-state-"));
  options = { stateDir, records: stateDirProjectRecords(stateDir), now: () => 1_700_000_400_000 };
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

function open() {
  const r = openProject(folder, options);
  if (!r.ok) throw new Error(r.problem.message);
  return r.opened;
}

/** The person's decision, written to the store as runtime.projectDecision does. */
function decide(decision: (p: ProjectState) => ProjectDecision) {
  const opened = open();
  const d = decision(opened.project);
  const r = applyProjectDecision(opened.project, d, { now: 9 });
  if (!r.ok) throw new Error(r.error.message);
  const saved = commitProject(folder, opened.stored.id, { revision: opened.stored.revision, decisionSeq: opened.decisionSeq }, r.project, { ...options, decision: d, decidedOn: opened.project });
  if (!saved.ok) throw new Error(saved.problem.message);
  return saved.opened.project;
}

function edit(change: (json: any) => void): void {
  const file = projectFilePath(folder);
  const json = JSON.parse(readFileSync(file, "utf8"));
  change(json);
  writeFileSync(file, JSON.stringify(json));
}

describe("decision status is record-owned (issue #112)", () => {
  it("a deferral at the plan gate is recorded in the state dir, never in project.json", () => {
    const created = createProject(folder, planDraft([row("t1", "m1", ["d1"]), row("t2", "m1")]), options);
    if (!created.ok) throw new Error(created.problem.message);
    decide((p) => ({ gate: p.gate, version: gateVersion(p)!, verdict: "edit", edits: { decisionStatus: { d2: "deferred" } } }));
    const reopened = open().project;
    expect(reopened.decisionStatus).toEqual({ d2: "deferred" });
    expect(JSON.parse(readFileSync(projectFilePath(folder), "utf8")).project.decisionStatus).toBeUndefined();
    const record = options.records.read(folder);
    expect(record.ok && record.record?.state.decisionStatus).toEqual({ d2: "deferred" });
    expect(record.ok && record.record?.decisions.at(-1)).toMatchObject({ gate: { kind: "plan" }, verdict: "edit" });
    expect(readFileSync(join(folder, ".atomic", "project", "BRIEF.md"), "utf8")).toContain("No new dependencies (deferred)");
    // The person approves the plan.
    const approved = decide((p) => ({ gate: p.gate, version: gateVersion(p)!, verdict: "approve" }));
    expect(approved.plan?.status).toBe("approved");
  });

  it("a status written into project.json cannot unblock the plan", () => {
    const created = createProject(folder, planDraft([row("t1", "m1", ["d1"]), row("t2", "m1")]), options);
    if (!created.ok) throw new Error(created.problem.message);
    edit((j) => {
      j.project.decisionStatus = { d2: "deferred" };
      j.project.brief.decisions[1].status = "deferred";
    });
    const p = open().project;
    expect(p.decisionStatus).toBeUndefined();
    expect(applyProjectDecision(p, { gate: p.gate, version: gateVersion(p)!, verdict: "approve" }, { now: 9 })).toMatchObject({ ok: false, error: { code: "review-open" } });
  });
});

describe("changing a decision (issue #112)", () => {
  const up = (p: ProjectState, u: Parameters<typeof applyProjectUpdate>[1], now = 10) => {
    const r = applyProjectUpdate(p, u, now);
    if (!r.ok) throw new Error(r.error.message);
    return r.project;
  };
  const yes = (p: ProjectState, now = 11) => {
    const r = applyProjectDecision(p, { gate: p.gate, version: gateVersion(p)!, verdict: "approve" }, { now });
    if (!r.ok) throw new Error(r.error.message);
    return r.project;
  };
  /** m1 (citing d1) reviewed after a run; m2 (citing d2) approved, not run. */
  function reviewed(): ProjectState {
    let p = yes(planDraft([row("t1", "m1", ["d1"]), row("t2", "m2", ["d2"])]));
    p = up(p, { kind: "milestone_run", id: "m1", runId: "run-1" });
    p = up(p, { kind: "milestone", id: "m1", state: "done", summary: "Built on SQLite" });
    return yes(p);
  }
  const redraft = (p: ProjectState, decisions: ProjectBriefDecision[]) =>
    up(p, { kind: "brief", brief: { what: "Notes app", users: "Me", how: "Node", successCriteria: criteria, decisions }, draftedAfterUntrusted: false }, 20);

  it("approving a changed decision's text puts the milestones citing it back to planned, their evidence in history", () => {
    const before = reviewed();
    expect(before.milestones.map((m) => m.state)).toEqual(["reviewed", "approved"]);
    const draft = redraft(before, [{ id: "d1", text: "Use Postgres" }, DECISIONS[1]!]);
    // A draft resets nothing: the person has not approved it.
    expect(draft.milestones[0]).toMatchObject({ state: "reviewed", runIds: ["run-1"] });
    const after = yes(draft, 30);
    const m1 = after.milestones[0]!;
    expect(m1).toMatchObject({ id: "m1", state: "planned", runIds: [] });
    expect(m1.summary).toBeUndefined();
    expect(m1.history).toEqual([expect.objectContaining({
      state: "reviewed",
      runIds: ["run-1"],
      summary: "Built on SQLite",
      cause: "brief",
      decisions: [{ id: "d1", text: "Use SQLite, not Postgres" }],
      supersededAt: 30,
    })]);
    expect(after.milestones[1]).toMatchObject({ id: "m2", state: "planned" });
    expect(after.milestones[1]!.history).toBeUndefined();
    expect(after.plan?.verdictResets).toEqual(["m1"]);
    expect(after.approvedDecisions).toEqual([{ id: "d1", text: "Use Postgres" }, DECISIONS[1]]);
    // The history entry reads back.
    expect(normalizeProject(JSON.parse(JSON.stringify(after)))?.milestones[0]?.history).toEqual(m1.history);
  });

  it("the reset reads what the milestone's tasks cited when it ran, never a later draft (review)", () => {
    const before = reviewed();
    expect(before.milestones[0]!.decisionsCited).toEqual([DECISIONS[0]]);
    // The director moves the citation off m1's task in a draft (or a shell edit lands as one): m1's work is unchanged.
    const moved = up(before, { kind: "plan", milestones: [{ id: "m1", title: "Milestone m1", kind: "base" }, { id: "m2", title: "Milestone m2", kind: "base" }], rows: [row("t1", "m1"), row("t2", "m2", ["d1", "d2"])], detail: "full" }, 15);
    expect(moved.milestones[0]).toMatchObject({ state: "reviewed", decisionsCited: [DECISIONS[0]] });
    const after = yes(redraft(moved, [{ id: "d1", text: "Use Postgres" }, DECISIONS[1]!]), 30);
    expect(after.milestones[0]).toMatchObject({ state: "planned", runIds: [] });
    expect(after.milestones[0]!.history?.at(-1)).toMatchObject({ cause: "brief", decisions: [DECISIONS[0]] });
    // The snapshot is the runtime's: it reads back from the record.
    expect(normalizeProject(JSON.parse(JSON.stringify(before)))?.milestones[0]?.decisionsCited).toEqual([DECISIONS[0]]);
  });

  it("a milestone recorded before the snapshot falls back to the approved plan's rows only", () => {
    const strip = (p: ProjectState): ProjectState => ({ ...p, milestones: p.milestones.map(({ decisionsCited: _d, ...m }) => m) });
    const approvedPlan = strip(reviewed());
    expect(yes(redraft(approvedPlan, [{ id: "d1", text: "Use Postgres" }, DECISIONS[1]!]), 30).milestones[0]!.state).toBe("planned");
  });

  it("an editorial change (case, spaces), another decision's change or an added decision keeps the verdict", () => {
    const before = reviewed();
    for (const decisions of [
      [{ id: "d1", text: "use  sqlite, NOT postgres" }, DECISIONS[1]!],
      [DECISIONS[0]!, { id: "d2", text: "One new dependency at most" }],
      [...DECISIONS, { id: "d3", text: "Formal tone" }],
    ]) {
      const after = yes(redraft(before, decisions), 30);
      expect(after.milestones[0], JSON.stringify(decisions)).toMatchObject({ state: "reviewed", runIds: ["run-1"] });
      expect(after.milestones[0]!.history).toBeUndefined();
    }
  });
});
