/**
 * Backlog coverage (issue #146): an item the person promoted must be
 * cited by a task (`rows[].backlog`) of a milestone that will still run
 * before the plan can be approved; the plan gate names what is missing.
 * The rule and its wording follow decision coverage (#112).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyBacklogDecision, promotedForPlan } from "./project-backlog.js";
import { stateDirProjectRecords } from "./project-decisions.js";
import { commitProject, createProject, openProject, projectFilePath, type ProjectStoreOptions } from "./project-store.js";
import { projectGateView } from "../tools/fusion/project-gate-view.js";
import {
  applyProjectDecision,
  applyProjectUpdate,
  gateVersion,
  normalizeProject,
  type AssignmentRow,
  type ProjectDecision,
  type ProjectState,
} from "./session-project.js";

const criteria = [{ id: "c1", text: "Stores notes" }];

const backlogRow = (taskId: string, milestoneId: string, backlog?: string[]): AssignmentRow => ({
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
  ...(backlog === undefined ? {} : { backlog }),
});
const row = backlogRow;

const ok = <T extends { ok: true; project: ProjectState } | { ok: false; error: { message: string } }>(r: T): ProjectState => {
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
};

/** An approved brief with backlog items b1, b2; `promoted` promoted by the person. */
function withBacklog(promoted: string[] = ["b1"]): ProjectState {
  let p = ok(applyProjectUpdate(undefined, { kind: "brief", brief: { what: "Notes app", users: "Me", how: "Node", successCriteria: criteria }, draftedAfterUntrusted: false }, 1));
  p = ok(applyProjectDecision(p, { gate: { kind: "brief" }, version: gateVersion(p)!, verdict: "approve" }, { now: 2 }));
  p = ok(applyProjectUpdate(p, { kind: "backlog_add", item: { title: "Export to PDF", source: "director" } }, 2));
  p = ok(applyProjectUpdate(p, { kind: "backlog_add", item: { title: "Dark mode", source: "director" } }, 2));
  for (const id of promoted) p = ok(applyBacklogDecision(p, { id, state: "promoted" }));
  return p;
}

const plan = (p: ProjectState, rows: AssignmentRow[], now = 3): ProjectState => ok(applyProjectUpdate(p, {
  kind: "plan",
  milestones: [...new Set(rows.map((r) => r.milestoneId))].map((id) => ({ id, title: `Milestone ${id}`, kind: "base" as const })),
  rows,
  detail: "full",
}, now));

const approve = (p: ProjectState) => applyProjectDecision(p, { gate: p.gate, version: gateVersion(p)!, verdict: "approve" }, { now: 4 });
const view = (p: ProjectState) => projectGateView({ sessionId: "s", project: p, estimate: null, selectable: { workers: [], reviewers: [] } });

describe("backlog coverage at the plan gate (issue #146)", () => {
  it("a plan that cites no task for a promoted item cannot be approved, and the gate names it", () => {
    const p = plan(withBacklog(), [row("t1", "m1"), row("t2", "m1", ["b2"])]);
    const r = approve(p);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("review-open");
    expect(r.error.message).toContain("backlog-coverage");
    expect(r.error.message).toContain("b1 (Export to PDF)");
    expect(view(p).hints).toContainEqual(expect.stringMatching(/^backlog-coverage: fail: No plan task that will run cites promoted backlog items: b1/));
    expect(p.plan?.checkResults).toContainEqual(expect.objectContaining({ dimension: "backlog-coverage", verdict: "fail" }));
  });

  it("a plan citing every promoted item on a task is approved", () => {
    const p = plan(withBacklog(), [row("t1", "m1"), row("t2", "m2", ["b1"])]);
    expect(view(p).hints).toContainEqual(expect.stringMatching(/^backlog-coverage: pass/));
    const approved = ok(approve(p));
    expect(approved.plan?.status).toBe("approved");
    expect(approved.backlogCalls?.b1?.plannedIn).toBe(p.plan!.version);
  });

  it("a project with no promoted item waiting has no coverage check; an unknown id warns", () => {
    const none = plan(withBacklog([]), [row("t1", "m1")]);
    expect(view(none).hints.some((h) => h.startsWith("backlog-coverage"))).toBe(false);
    expect(approve(none).ok).toBe(true);
    const stray = plan(withBacklog([]), [row("t1", "m1", ["b9"])]);
    expect(view(stray).hints).toContainEqual("backlog-coverage: warn: Tasks cite ids that are no backlog item: t1 (b9).");
    expect(approve(stray).ok).toBe(true);
  });

  it("a stored pass is not trusted: the load recomputes it from the record's calls", () => {
    const raw = JSON.parse(JSON.stringify(plan(withBacklog(), [{ ...row("t1", "m1"), checks: [{ cmd: "node --test" }] }])));
    raw.plan.checkResults = [{ dimension: "backlog-coverage", verdict: "pass", detail: "forged", taskIds: [] }];
    expect(normalizeProject(raw)?.plan?.checkResults).toContainEqual(expect.objectContaining({ dimension: "backlog-coverage", verdict: "fail" }));
  });

  it("a citation added to a finished milestone's task does not cover an item", () => {
    // m1 runs and is reviewed under a plan with nothing promoted; then the person promotes b1.
    let p = ok(approve(plan(withBacklog([]), [row("t1", "m1"), row("t2", "m2")])));
    p = ok(applyProjectUpdate(p, { kind: "milestone_run", id: "m1", runId: "run-1" }, 5));
    p = ok(applyProjectUpdate(p, { kind: "milestone", id: "m1", state: "done", summary: "Built" }, 6));
    p = ok(approve(p));
    expect(p.milestones.map((m) => m.state)).toEqual(["reviewed", "approved"]);
    p = ok(applyBacklogDecision(p, { id: "b1", state: "promoted" }));
    const late = plan(p, [row("t1", "m1", ["b1"]), row("t2", "m2")], 7);
    expect(late.milestones[0]!.state).toBe("reviewed");
    const refused = approve(late);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.message).toContain("t1 is in a finished milestone (m1); cite b1 on a task that will run");
    expect(ok(approve(plan(p, [row("t1", "m1"), row("t2", "m2", ["b1"])], 7))).backlogCalls?.b1?.plannedIn).toBeGreaterThan(0);
  });
});

describe("older projects and running plans (issue #146)", () => {
  it("a project saved before rows[].backlog opens without errors and without a coverage check", () => {
    for (const name of ["project-saved-before-80.json", "project-saved-before-80-draft-brief.json"]) {
      const raw = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8")) as { project?: unknown; session?: { project?: unknown } };
      const p = normalizeProject(raw.project ?? raw.session?.project ?? raw);
      expect(p, name).toBeDefined();
      expect(p!.plan?.rows.every((r) => r.backlog === undefined)).toBe(true);
      expect(view(p!).hints.some((h) => h.startsWith("backlog-coverage"))).toBe(false);
    }
  });

  it("an item promoted while an approved plan runs waits for the next draft: the running plan is not wedged", () => {
    let p = ok(approve(plan(withBacklog([]), [{ ...row("t1", "m1"), checks: [{ cmd: "node --test" }] }, row("t2", "m2")])));
    p = ok(applyBacklogDecision(p, { id: "b1", state: "promoted" }));
    // As a store from before this change holds it: approved plan, b1 promoted, no plannedIn.
    const reread = normalizeProject(JSON.parse(JSON.stringify(p)))!;
    expect(reread.plan?.status).toBe("approved");
    expect(reread.backlogCalls?.b1?.plannedIn).toBeUndefined();
    expect(reread.plan?.checkResults?.some((r) => r.dimension === "backlog-coverage")).toBe(false);
    // The milestones keep running and their results are decided.
    p = ok(applyProjectUpdate(reread, { kind: "milestone_run", id: "m1", runId: "run-1" }, 5));
    p = ok(applyProjectUpdate(p, { kind: "milestone", id: "m1", state: "done", summary: "Built" }, 6));
    p = ok(approve(p));
    expect(p.milestones.map((m) => m.state)).toEqual(["reviewed", "approved"]);
    // The next draft must take it in (or the person defers it).
    expect(approve(plan(p, [row("t1", "m1"), row("t2", "m2")], 7))).toMatchObject({ ok: false, error: { code: "review-open" } });
  });
});

describe("deferring a promoted item at the plan gate (issue #146)", () => {
  const defer = (p: ProjectState, backlogStatus: Record<string, string>) =>
    applyProjectDecision(p, { gate: p.gate, version: gateVersion(p)!, verdict: "edit", edits: { backlogStatus } as never }, { now: 5 });

  it("the person's deferral unblocks the plan, keeps the item promoted and the rows, and is shown", () => {
    const p = plan(withBacklog(), [row("t1", "m1")]);
    const r = ok(defer(p, { b1: "deferred" }));
    expect(r.backlogCalls?.b1?.deferred).toBe(true);
    expect(r.backlogStates).toEqual({ b1: "promoted" });
    expect(r.gate).toEqual({ kind: "plan" });
    expect(gateVersion(r)).toBe(gateVersion(p)! + 1);
    expect(r.plan?.rows).toEqual(p.plan?.rows);
    const shown = view(r);
    expect(shown.hints).toContainEqual(expect.stringMatching(/^backlog-coverage: pass: .*Not required: b1 \(deferred\)/));
    expect(shown.hints).toContain('promoted from the backlog, deferred by you: b1 "Export to PDF": this plan need not take it in; set it active again to require it');
    expect(shown.backlog?.promoted).toEqual([{ id: "b1", title: "Export to PDF", deferred: true }]);
    expect(shown.backlog?.items.find((b) => b.id === "b1")).toMatchObject({ state: "promoted", deferred: true });
    expect(ok(approve(r)).plan?.status).toBe("approved");
    // An old card cannot approve the plan the deferral changed.
    expect(applyProjectDecision(r, { gate: p.gate, version: gateVersion(p)!, verdict: "approve" }, { now: 6 })).toMatchObject({ ok: false, error: { code: "stale-version" } });
    // Setting it active again puts the block back; the deferral reads back from the record.
    expect(normalizeProject(JSON.parse(JSON.stringify(r)))?.backlogCalls).toEqual(r.backlogCalls);
    const back = ok(defer(r, { b1: "active" }));
    expect(back.backlogCalls?.b1?.deferred).toBeUndefined();
    expect(approve(back)).toMatchObject({ ok: false, error: { code: "review-open" } });
  });

  it("a promotion given again clears the deferral", () => {
    const r = ok(defer(plan(withBacklog(), [row("t1", "m1")]), { b1: "deferred" }));
    const again = ok(applyBacklogDecision(r, { id: "b1", state: "promoted" }));
    expect(again.backlogCalls?.b1?.deferred).toBeUndefined();
  });

  it("an item not promoted, unknown or already taken in, a bad status, or another gate is refused", () => {
    const p = plan(withBacklog(), [row("t1", "m1")]);
    for (const bad of [{ b2: "deferred" }, { b9: "deferred" }, { b1: "dropped" }, { b1: "bogus" }] as Record<string, string>[]) {
      expect(defer(p, bad), JSON.stringify(bad)).toMatchObject({ ok: false, error: { code: "invalid" } });
    }
    const taken = ok(approve(plan(withBacklog(), [row("t1", "m1", ["b1"])])));
    const replanned = plan(taken, [row("t1", "m1", ["b1"]), row("t2", "m2")], 8);
    expect(defer(replanned, { b1: "deferred" })).toMatchObject({ ok: false, error: { code: "invalid" } });
    const atBrief = ok(applyProjectUpdate(undefined, { kind: "brief", brief: { what: "x", users: "y", how: "z", successCriteria: criteria }, draftedAfterUntrusted: false }, 1));
    expect(defer(atBrief, { b1: "deferred" })).toMatchObject({ ok: false, error: { code: "invalid" } });
  });

  it("no director update carries a deferral: a plan update keeps the person's, and a forged one in a stored call is dropped unless promoted", () => {
    const r = ok(defer(plan(withBacklog(), [row("t1", "m1")]), { b1: "deferred" }));
    const redraft = plan(r, [row("t1", "m1"), row("t2", "m1")], 9);
    expect(redraft.backlogCalls?.b1?.deferred).toBe(true);
    const raw = JSON.parse(JSON.stringify(withBacklog(["b1"])));
    raw.backlogStates.b2 = "dropped";
    raw.backlogCalls.b2 = { hash: raw.backlogCalls.b1.hash, deferred: true };
    expect(normalizeProject(raw)?.backlogCalls?.b2?.deferred).toBeUndefined();
  });

  it("the wire parse takes edits.backlogStatus and refuses anything else", async () => {
    const { parseProjectDecision } = await import("./project-decision-parse.js");
    expect(parseProjectDecision({ gate: { kind: "plan" }, version: 3, verdict: "edit", edits: { backlogStatus: { b1: "deferred" } } })).toEqual({
      gate: { kind: "plan" }, version: 3, verdict: "edit", edits: { backlogStatus: { b1: "deferred" } },
    });
    for (const bad of [[], "deferred", { b1: 1 }, { b1: "dropped" }, { "Bad Id": "deferred" }]) {
      expect(typeof parseProjectDecision({ gate: { kind: "plan" }, version: 3, verdict: "edit", edits: { backlogStatus: bad } }), JSON.stringify(bad)).toBe("string");
    }
  });
});

describe("a deferral is record-owned (issue #146)", () => {
  let folder: string;
  let stateDir: string;
  let options: ProjectStoreOptions;
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "aa-backlog-cov-"));
    stateDir = mkdtempSync(join(tmpdir(), "aa-backlog-cov-state-"));
    options = { stateDir, records: stateDirProjectRecords(stateDir), now: () => 1_700_000_500_000 };
  });
  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });
  const open = () => {
    const r = openProject(folder, options);
    if (!r.ok) throw new Error(r.problem.message);
    return r.opened;
  };
  const decide = (decision: (p: ProjectState) => ProjectDecision) => {
    const opened = open();
    const d = decision(opened.project);
    const r = ok(applyProjectDecision(opened.project, d, { now: 9 }));
    const saved = commitProject(folder, opened.stored.id, { revision: opened.stored.revision, decisionSeq: opened.decisionSeq }, r, { ...options, decision: d, decidedOn: opened.project });
    if (!saved.ok) throw new Error(saved.problem.message);
    return saved.opened.project;
  };

  it("is recorded in the state dir, never in project.json; one written into project.json does nothing", () => {
    const created = createProject(folder, plan(withBacklog(), [row("t1", "m1")]), options);
    if (!created.ok) throw new Error(created.problem.message);
    // Forged in the file: the plan stays blocked.
    const file = projectFilePath(folder);
    const json = JSON.parse(readFileSync(file, "utf8"));
    json.project.backlogCalls = { b1: { hash: "0000000000000000", deferred: true } };
    json.project.backlog[0].deferred = true;
    writeFileSync(file, JSON.stringify(json));
    const forged = open().project;
    expect(forged.backlogCalls?.b1?.deferred).toBeUndefined();
    expect(approve(forged)).toMatchObject({ ok: false, error: { code: "review-open" } });
    decide((p) => ({ gate: p.gate, version: gateVersion(p)!, verdict: "edit", edits: { backlogStatus: { b1: "deferred" } } }));
    expect(open().project.backlogCalls?.b1?.deferred).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).project.backlogCalls).toBeUndefined();
    const record = options.records.read(folder);
    expect(record.ok && record.record?.state.backlogCalls?.b1?.deferred).toBe(true);
    expect(decide((p) => ({ gate: p.gate, version: gateVersion(p)!, verdict: "approve" })).plan?.status).toBe("approved");
  });
});

describe("plannedIn records only what the approved plan cites (issue #146)", () => {
  const defer = (p: ProjectState, backlogStatus: Record<string, string>) =>
    ok(applyProjectDecision(p, { gate: p.gate, version: gateVersion(p)!, verdict: "edit", edits: { backlogStatus } as never }, { now: 5 }));

  it("a deferred item no task cites stays promoted and waiting; a cited one is taken in by the version approved", () => {
    const p = defer(plan(withBacklog(["b1", "b2"]), [row("t1", "m1", ["b2"])]), { b1: "deferred" });
    const approved = ok(approve(p));
    expect(approved.backlogCalls?.b2?.plannedIn).toBe(p.plan!.version);
    expect(approved.backlogCalls?.b1?.plannedIn).toBeUndefined();
    expect(approved.backlogCalls?.b1?.deferred).toBe(true);
    expect(promotedForPlan(approved).map((b) => b.id)).toEqual(["b1"]);
  });

  it("a deferred item the plan cites anyway is taken in, and its deferral goes with it", () => {
    const p = defer(plan(withBacklog(["b1"]), [row("t1", "m1", ["b1"])]), { b1: "deferred" });
    const approved = ok(approve(p));
    expect(approved.backlogCalls?.b1).toEqual({ hash: expect.any(String), plannedIn: p.plan!.version, cited: true });
  });

  it("a citation on a finished milestone's task does not take an item in", () => {
    let p = ok(approve(plan(withBacklog([]), [row("t1", "m1"), row("t2", "m2")])));
    p = ok(applyProjectUpdate(p, { kind: "milestone_run", id: "m1", runId: "run-1" }, 5));
    p = ok(approve(ok(applyProjectUpdate(p, { kind: "milestone", id: "m1", state: "done", summary: "Built" }, 6))));
    p = ok(applyBacklogDecision(p, { id: "b1", state: "promoted" }));
    const late = defer(plan(p, [row("t1", "m1", ["b1"]), row("t2", "m2")], 7), { b1: "deferred" });
    expect(ok(approve(late)).backlogCalls?.b1?.plannedIn).toBeUndefined();
  });
});

describe("an item stays taken in only while the plan still holds it (issue #146 review)", () => {
  it("a re-plan that drops the citation before the citing milestone ran requires the item again", () => {
    const v1 = ok(approve(plan(withBacklog(["b1"]), [row("t1", "m1"), row("t2", "m2", ["b1"])])));
    expect(v1.backlogCalls?.b1?.plannedIn).toBe(v1.plan!.version);
    expect(promotedForPlan(v1)).toEqual([]);
    // The director re-plans before m2 runs, dropping b1's citation.
    const v2 = plan(v1, [row("t1", "m1"), row("t3", "m2")], 5);
    expect(promotedForPlan(v2).map((b) => b.id)).toEqual(["b1"]);
    expect(view(v2).hints).toContainEqual(expect.stringMatching(/^backlog-coverage: fail: .*b1/));
    expect(approve(v2)).toMatchObject({ ok: false, error: { code: "review-open" } });
    // The person may defer it again, which unblocks the plan.
    const deferred = ok(applyProjectDecision(v2, { gate: v2.gate, version: gateVersion(v2)!, verdict: "edit", edits: { backlogStatus: { b1: "deferred" } } }, { now: 6 }));
    expect(approve(deferred).ok).toBe(true);
    // A re-plan that keeps the citation keeps it taken in by v1.
    const kept = plan(v1, [row("t1", "m1"), row("t2", "m2", ["b1"]), row("t4", "m2")], 5);
    expect(promotedForPlan(kept)).toEqual([]);
    const again = ok(approve(kept));
    expect(again.backlogCalls?.b1?.plannedIn).toBe(v1.plan!.version);
  });

  it("an item whose citing milestone ran stays taken in when a later plan no longer cites it", () => {
    let p = ok(approve(plan(withBacklog(["b1"]), [row("t1", "m1", ["b1"]), row("t2", "m2")])));
    expect(p.milestones[0]!.backlogCited).toEqual(["b1"]);
    p = ok(applyProjectUpdate(p, { kind: "milestone_run", id: "m1", runId: "run-1" }, 5));
    p = ok(approve(ok(applyProjectUpdate(p, { kind: "milestone", id: "m1", state: "done", summary: "Built" }, 6))));
    const later = plan(p, [row("t1", "m1"), row("t2", "m2")], 7);
    expect(promotedForPlan(later)).toEqual([]);
    expect(ok(approve(later)).plan?.status).toBe("approved");
    // The snapshot is the runtime's: it reads back from the record.
    expect(normalizeProject(JSON.parse(JSON.stringify(later)))?.milestones[0]?.backlogCited).toEqual(["b1"]);
  });

  it("an item taken in by the approximate rule before this change stays taken in", () => {
    const p = plan(withBacklog(["b1"]), [row("t1", "m1")]);
    const legacy: ProjectState = { ...p, backlogCalls: { b1: { hash: p.backlogCalls!.b1!.hash, plannedIn: 1 } } };
    expect(promotedForPlan(normalizeProject(JSON.parse(JSON.stringify(legacy)))!)).toEqual([]);
  });
});
