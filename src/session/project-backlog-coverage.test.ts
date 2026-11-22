/**
 * Backlog coverage (issue #146): an item the person promoted must be
 * cited by a task (`rows[].backlog`) of a milestone that will still run
 * before the plan can be approved; the plan gate names what is missing.
 * The rule and its wording follow decision coverage (#112).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { applyBacklogDecision } from "./project-backlog.js";
import { projectGateView } from "../tools/fusion/project-gate-view.js";
import {
  applyProjectDecision,
  applyProjectUpdate,
  gateVersion,
  normalizeProject,
  type AssignmentRow,
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
