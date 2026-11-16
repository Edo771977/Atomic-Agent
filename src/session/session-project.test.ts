import { describe, expect, it } from "vitest";

import {
  PROJECT_LIMITS,
  allowedProjectVerdicts,
  applyProjectDecision,
  applyProjectUpdate,
  gateVersion,
  normalizeProject,
  planTotals,
  projectExpectation,
  readProject,
  withProject,
  type AssignmentRow,
  type ProjectState,
  type ProjectUpdate,
} from "./session-project.js";
import { createEmptySessionState } from "./session-state.js";
import { normalizeSessionState } from "./normalize-session-state.js";

const NOW = 1_700_000_000_000;

const briefUpdate: ProjectUpdate = {
  kind: "brief",
  brief: {
    what: "A small puzzle game",
    users: "Casual players",
    how: "Browser, plain TypeScript",
    successCriteria: ["Runs in the browser", "Has three levels"],
  },
  draftedAfterUntrusted: false,
};

function row(taskId: string, milestoneId: string, extra: Partial<AssignmentRow> = {}): AssignmentRow {
  return {
    taskId,
    title: `Task ${taskId}`,
    milestoneId,
    worker: "local:model-a",
    reviewer: "cloud:model-b",
    reason: "insufficient data, chosen from the preset",
    basis: "preset",
    samples: 0,
    estCostUsd: 0.1,
    estMs: 1000,
    ...extra,
  };
}

const planUpdate: ProjectUpdate = {
  kind: "plan",
  milestones: [
    { id: "m1", title: "Base", kind: "base" },
    { id: "m2", title: "UI", kind: "ui" },
  ],
  rows: [row("t1", "m1"), row("t2", "m2")],
  detail: "compact",
};

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
}

function update(project: ProjectState | undefined, u: ProjectUpdate, now = NOW): ProjectState {
  return ok(applyProjectUpdate(project, u, now)).project;
}

function approve(project: ProjectState, now = NOW): ProjectState {
  const v = gateVersion(project);
  if (v === null) throw new Error("no gate");
  return ok(applyProjectDecision(project, { gate: project.gate, version: v, verdict: "approve" }, { now })).project;
}

/** Brief drafted and approved, plan drafted and approved. */
function running(): ProjectState {
  return approve(update(approve(update(undefined, briefUpdate)), planUpdate));
}

describe("applyProjectUpdate: brief", () => {
  it("creates a draft brief at version 1 and opens the brief gate", () => {
    const p = update(undefined, briefUpdate);
    expect(p.brief).toMatchObject({ version: 1, status: "draft", draftedAfterUntrusted: false });
    expect(p.brief?.successCriteria).toEqual(["Runs in the browser", "Has three levels"]);
    expect(p.gate).toEqual({ kind: "brief" });
    expect(p.milestones).toEqual([]);
  });

  it("an edit of an approved brief resets it to draft and bumps the version", () => {
    const approved = approve(update(undefined, briefUpdate));
    expect(approved.brief?.status).toBe("approved");
    const edited = update(approved, { ...briefUpdate, brief: { ...briefUpdate.brief, what: "Another game" } });
    expect(edited.brief).toMatchObject({ version: 2, status: "draft", what: "Another game" });
    expect(edited.brief?.approvedAt).toBeUndefined();
    expect(edited.gate).toEqual({ kind: "brief" });
  });

  it("the model cannot approve: a status in the update is ignored", () => {
    const sneaky = { ...briefUpdate, brief: { ...briefUpdate.brief, status: "approved" } } as unknown as ProjectUpdate;
    expect(update(undefined, sneaky).brief?.status).toBe("draft");
  });

  it("records the taint flag", () => {
    expect(update(undefined, { ...briefUpdate, draftedAfterUntrusted: true }).brief?.draftedAfterUntrusted).toBe(true);
  });

  it("a brief edit sends an approved plan back to draft and un-approves unstarted milestones", () => {
    const p = running();
    expect(p.milestones[0]!.state).toBe("approved");
    const edited = update(p, { ...briefUpdate, brief: { ...briefUpdate.brief, how: "Canvas" } });
    expect(edited.plan?.status).toBe("draft");
    expect(edited.plan!.version).toBe(p.plan!.version + 1);
    expect(edited.milestones.map((m) => m.state)).toEqual(["planned", "planned"]);
  });

  it("refuses an empty what and too many success criteria", () => {
    expect(applyProjectUpdate(undefined, { ...briefUpdate, brief: { ...briefUpdate.brief, what: "  " } }, NOW))
      .toMatchObject({ ok: false, error: { code: "invalid" } });
    const many = Array.from({ length: PROJECT_LIMITS.successCriteria + 1 }, (_, i) => `c${i}`);
    expect(applyProjectUpdate(undefined, { ...briefUpdate, brief: { ...briefUpdate.brief, successCriteria: many } }, NOW))
      .toMatchObject({ ok: false, error: { code: "invalid" } });
  });

  it("clips long text", () => {
    const long = "x".repeat(PROJECT_LIMITS.text + 50);
    const p = update(undefined, { ...briefUpdate, brief: { ...briefUpdate.brief, how: long } });
    expect(p.brief!.how.length).toBe(PROJECT_LIMITS.text);
    expect(p.brief!.how.endsWith("…")).toBe(true);
  });

  it("a new brief after a cancel starts over", () => {
    const p = running();
    const cancelled = ok(applyProjectDecision(p, { gate: { kind: "none" }, version: p.plan!.version, verdict: "cancel" }, { now: NOW })).project;
    expect(cancelled.cancelledAt).toBe(NOW);
    const fresh = update(cancelled, briefUpdate);
    expect(fresh.cancelledAt).toBeUndefined();
    expect(fresh.plan).toBeUndefined();
    expect(fresh.milestones).toEqual([]);
    expect(fresh.brief!.version).toBeGreaterThan(p.plan!.version);
  });

  it("versions never restart after a cancel: a card of the old project cannot approve the new brief or plan", () => {
    const first = update(undefined, briefUpdate);
    expect(first.brief!.version).toBe(1);
    const cancelled = ok(applyProjectDecision(first, { gate: { kind: "brief" }, version: 1, verdict: "cancel" }, { now: NOW })).project;
    const fresh = update(cancelled, { ...briefUpdate, brief: { ...briefUpdate.brief, what: "Something else" } });
    expect(applyProjectDecision(fresh, { gate: { kind: "brief" }, version: 1, verdict: "approve" }, { now: NOW }))
      .toMatchObject({ ok: false, error: { code: "stale-version" } });
    // It survives a save and reload.
    const reloaded = normalizeProject(JSON.parse(JSON.stringify(cancelled)))!;
    expect(update(reloaded, briefUpdate).brief!.version).toBe(fresh.brief!.version);
    // And a plan of the new project starts above the old one's plan.
    const old = running();
    const oldPlan = old.plan!.version;
    const c2 = ok(applyProjectDecision(old, { gate: { kind: "none" }, version: oldPlan, verdict: "cancel" }, { now: NOW })).project;
    const replanned = update(approve(update(c2, briefUpdate)), planUpdate);
    expect(replanned.plan!.version).toBeGreaterThan(oldPlan);
    expect(applyProjectDecision(replanned, { gate: { kind: "plan" }, version: oldPlan, verdict: "approve" }, { now: NOW }))
      .toMatchObject({ ok: false, error: { code: "stale-version" } });
  });
});

describe("applyProjectUpdate: plan", () => {
  it("records a plan drafted after outside content; its approval records that the warning was shown", () => {
    const approvedBrief = approve(update(undefined, briefUpdate));
    const clean = update(approvedBrief, planUpdate);
    expect(clean.plan!.draftedAfterUntrusted).toBe(false);
    const tainted = update(approvedBrief, { ...planUpdate, draftedAfterUntrusted: true } as ProjectUpdate);
    expect(tainted.plan!.draftedAfterUntrusted).toBe(true);
    expect(tainted.plan!.approvedWithUntrustedWarning).toBeUndefined();
    const approved = approve(tainted);
    expect(approved.plan).toMatchObject({ status: "approved", draftedAfterUntrusted: true, approvedWithUntrustedWarning: true });
    expect(approve(clean).plan!.approvedWithUntrustedWarning).toBeUndefined();
    expect(normalizeProject(JSON.parse(JSON.stringify(approved)))!.plan).toMatchObject({ draftedAfterUntrusted: true, approvedWithUntrustedWarning: true });
    // A person's edit keeps the flag; the re-approval shows it again.
    const edited = ok(applyProjectDecision(tainted, { gate: { kind: "plan" }, version: tainted.plan!.version, verdict: "edit", edits: { rows: [{ taskId: "t1", reviewer: null }] } }, { now: NOW })).project;
    expect(edited.plan!.draftedAfterUntrusted).toBe(true);
  });


  it("refuses a plan before the brief is approved", () => {
    expect(applyProjectUpdate(undefined, planUpdate, NOW)).toMatchObject({ ok: false, error: { code: "brief-not-approved" } });
    expect(applyProjectUpdate(update(undefined, briefUpdate), planUpdate, NOW))
      .toMatchObject({ ok: false, error: { code: "brief-not-approved" } });
  });

  it("drafts the plan with totals, planned milestones and the plan gate", () => {
    const p = update(approve(update(undefined, briefUpdate)), planUpdate);
    expect(p.plan).toMatchObject({ status: "draft", version: 1, detail: "compact", totals: { costUsd: 0.2, ms: 2000, unknownCostRows: 0 } });
    expect(p.milestones.map((m) => [m.id, m.state])).toEqual([["m1", "planned"], ["m2", "planned"]]);
    expect(p.gate).toEqual({ kind: "plan" });
  });

  it("refuses rows naming an unknown milestone and duplicate ids", () => {
    const base = approve(update(undefined, briefUpdate));
    expect(applyProjectUpdate(base, { ...planUpdate, rows: [row("t1", "nope")] }, NOW)).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(applyProjectUpdate(base, { ...planUpdate, rows: [row("t1", "m1"), row("t1", "m2")] }, NOW)).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(applyProjectUpdate(base, { ...planUpdate, milestones: [planUpdate.milestones[0]!, planUpdate.milestones[0]!] }, NOW))
      .toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(applyProjectUpdate(base, { ...planUpdate, rows: [] }, NOW)).toMatchObject({ ok: false, error: { code: "invalid" } });
  });

  it("re-planning an approved plan resets to draft, bumps the version and keeps finished milestones", () => {
    let p = running();
    p = update(p, { kind: "milestone_run", id: "m1", runId: "run-1" });
    p = update(p, { kind: "milestone", id: "m1", state: "done", summary: "Base works" });
    p = approve(p);
    const before = p.plan!.version;
    const re = update(p, { ...planUpdate, milestones: [...planUpdate.milestones, { id: "m3", title: "Polish", kind: "polish" }] });
    expect(re.plan).toMatchObject({ status: "draft", version: before + 1 });
    expect(re.plan!.approvedAt).toBeUndefined();
    expect(re.milestones.map((m) => [m.id, m.state])).toEqual([["m1", "reviewed"], ["m2", "planned"], ["m3", "planned"]]);
    expect(re.milestones[0]!.runIds).toEqual(["run-1"]);
    expect(re.gate).toEqual({ kind: "plan" });
  });
});

describe("applyProjectUpdate: milestones", () => {
  it("refuses a report for a milestone that is not approved", () => {
    const p = update(approve(update(undefined, briefUpdate)), planUpdate);
    expect(applyProjectUpdate(p, { kind: "milestone", id: "m1", state: "done", summary: "x" }, NOW))
      .toMatchObject({ ok: false, error: { code: "plan-not-approved" } });
    expect(applyProjectUpdate(p, { kind: "milestone_run", id: "m1", runId: "r" }, NOW))
      .toMatchObject({ ok: false, error: { code: "plan-not-approved" } });
    expect(applyProjectUpdate(running(), { kind: "milestone_run", id: "m2", runId: "r" }, NOW))
      .toMatchObject({ ok: false, error: { code: "milestone-not-approved" } });
    expect(applyProjectUpdate(running(), { kind: "milestone", id: "m2", state: "done", summary: "x" }, NOW))
      .toMatchObject({ ok: false, error: { code: "milestone-not-approved" } });
    expect(applyProjectUpdate(running(), { kind: "milestone", id: "zz", state: "done", summary: "x" }, NOW))
      .toMatchObject({ ok: false, error: { code: "unknown-milestone" } });
  });

  it("a run marks it in progress and records run ids once", () => {
    let p = update(running(), { kind: "milestone_run", id: "m1", runId: "r1" });
    p = update(p, { kind: "milestone_run", id: "m1", runId: "r1" });
    p = update(p, { kind: "milestone_run", id: "m1", runId: "r2" });
    expect(p.milestones[0]).toMatchObject({ state: "in_progress", runIds: ["r1", "r2"] });
  });

  it("a report records the summary, opens the milestone gate and bumps the plan version without un-approving it", () => {
    const r = running();
    const p = update(r, { kind: "milestone", id: "m1", state: "done", summary: "Base done" }, NOW + 5);
    expect(p.milestones[0]).toMatchObject({ state: "done", summary: "Base done", updatedAt: NOW + 5 });
    expect(p.gate).toEqual({ kind: "milestone", id: "m1" });
    expect(p.plan).toMatchObject({ status: "approved", version: r.plan!.version + 1 });
    expect(gateVersion(p)).toBe(p.plan!.version);
  });
});

describe("applyProjectDecision", () => {
  it("approving the brief clears the gate and expects a plan", () => {
    const p = approve(update(undefined, briefUpdate), NOW + 1);
    expect(p.brief).toMatchObject({ status: "approved", approvedAt: NOW + 1, version: 1 });
    expect(p.gate).toEqual({ kind: "none" });
    expect(projectExpectation(p)).toEqual({ kind: "draft_plan" });
  });

  it("approving the plan approves milestone 1", () => {
    const p = running();
    expect(p.plan).toMatchObject({ status: "approved", approvedAt: NOW });
    expect(p.milestones.map((m) => m.state)).toEqual(["approved", "planned"]);
    expect(p.gate).toEqual({ kind: "none" });
    expect(projectExpectation(p)).toEqual({ kind: "run_milestone", id: "m1" });
  });

  it("approving milestone N's result marks it reviewed and approves N+1; the last completes the project", () => {
    let p = update(running(), { kind: "milestone", id: "m1", state: "done", summary: "ok" });
    p = approve(p);
    expect(p.milestones.map((m) => m.state)).toEqual(["reviewed", "approved"]);
    expect(projectExpectation(p)).toEqual({ kind: "run_milestone", id: "m2" });
    p = update(p, { kind: "milestone", id: "m2", state: "done", summary: "ok" });
    p = approve(p);
    expect(p.milestones.map((m) => m.state)).toEqual(["reviewed", "reviewed"]);
    expect(p.gate).toEqual({ kind: "none" });
    expect(projectExpectation(p)).toEqual({ kind: "complete" });
  });

  it("approving a failed milestone re-approves it for another run", () => {
    let p = update(running(), { kind: "milestone", id: "m1", state: "failed", summary: "broken" });
    p = approve(p);
    expect(p.milestones.map((m) => m.state)).toEqual(["approved", "planned"]);
  });

  it("a correction at the milestone gate sends it back to approved with the note recorded", () => {
    const reported = update(running(), { kind: "milestone", id: "m1", state: "done", summary: "ok" });
    const v = gateVersion(reported)!;
    const p = ok(applyProjectDecision(
      reported,
      { gate: reported.gate, version: v, verdict: "edit", edits: { note: "  The score must  reset on restart. " } },
      { now: NOW + 9 },
    )).project;
    expect(p.milestones[0]).toMatchObject({
      state: "approved",
      corrections: [{ note: "The score must reset on restart.", at: NOW + 9 }],
      updatedAt: NOW + 9,
    });
    expect(p.milestones[1]!.state).toBe("planned");
    expect(p.gate).toEqual({ kind: "none" });
    expect(projectExpectation(p)).toEqual({ kind: "run_milestone", id: "m1" });
    // Another run, another report: the corrections stay.
    const again = update(update(p, { kind: "milestone_run", id: "m1", runId: "r2" }), { kind: "milestone", id: "m1", state: "done", summary: "fixed" });
    expect(again.milestones[0]!.corrections).toHaveLength(1);
  });

  it("a milestone correction needs a note, is clipped and keeps only the newest", () => {
    const reported = () => update(running(), { kind: "milestone", id: "m1", state: "failed", summary: "x" });
    const r = reported();
    expect(applyProjectDecision(r, { gate: r.gate, version: gateVersion(r)!, verdict: "edit" }, { now: NOW }))
      .toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(applyProjectDecision(r, { gate: r.gate, version: gateVersion(r)!, verdict: "edit", edits: { note: "   " } }, { now: NOW }))
      .toMatchObject({ ok: false, error: { code: "invalid" } });
    const long = ok(applyProjectDecision(r, { gate: r.gate, version: gateVersion(r)!, verdict: "edit", edits: { note: "x".repeat(5000) } }, { now: NOW })).project;
    expect(long.milestones[0]!.corrections![0]!.note.length).toBe(PROJECT_LIMITS.correctionNote);
    let p: ProjectState = r;
    for (let i = 0; i < PROJECT_LIMITS.corrections + 3; i += 1) {
      p = ok(applyProjectDecision(p, { gate: p.gate, version: gateVersion(p)!, verdict: "edit", edits: { note: `fix ${i}` } }, { now: NOW + i })).project;
      p = update(p, { kind: "milestone", id: "m1", state: "failed", summary: "again" });
    }
    const notes = p.milestones[0]!.corrections!.map((c) => c.note);
    expect(notes).toHaveLength(PROJECT_LIMITS.corrections);
    expect(notes.at(-1)).toBe(`fix ${PROJECT_LIMITS.corrections + 2}`);
    // Stored corrections survive normalization.
    expect(normalizeProject(JSON.parse(JSON.stringify(p)))!.milestones[0]!.corrections).toEqual(p.milestones[0]!.corrections);
  });

  it("refuses a stale version and a different gate", () => {
    const p = update(undefined, briefUpdate);
    expect(applyProjectDecision(p, { gate: { kind: "brief" }, version: 7, verdict: "approve" }, { now: NOW }))
      .toMatchObject({ ok: false, error: { code: "stale-version", current: 1 } });
    expect(applyProjectDecision(p, { gate: { kind: "plan" }, version: 1, verdict: "approve" }, { now: NOW }))
      .toMatchObject({ ok: false, error: { code: "wrong-gate" } });
    expect(applyProjectDecision(undefined, { gate: { kind: "brief" }, version: 1, verdict: "approve" }, { now: NOW }))
      .toMatchObject({ ok: false, error: { code: "no-project" } });
  });

  it("refuses approve while a hard cap is exceeded", () => {
    const p = update(approve(update(undefined, briefUpdate)), planUpdate);
    expect(applyProjectDecision(p, { gate: p.gate, version: 1, verdict: "approve" }, { now: NOW, hardViolations: ["over the turn budget"] }))
      .toMatchObject({ ok: false, error: { code: "over-cap" } });
  });

  it("refuses a verdict the gate does not allow", () => {
    const p = update(undefined, briefUpdate);
    expect(allowedProjectVerdicts(p.gate)).toEqual(["approve", "edit", "cancel"]);
    expect(applyProjectDecision(p, { gate: p.gate, version: 1, verdict: "cheaper" }, { now: NOW }))
      .toMatchObject({ ok: false, error: { code: "verdict-not-allowed" } });
    expect(allowedProjectVerdicts({ kind: "plan" })).toEqual(["approve", "edit", "cheaper", "quality", "cancel"]);
    expect(allowedProjectVerdicts({ kind: "milestone", id: "m1" })).toEqual(["approve", "edit", "cancel"]);
    expect(allowedProjectVerdicts({ kind: "none" })).toEqual(["cancel"]);
  });

  it("a person's brief edit keeps it a draft and bumps the version", () => {
    const p = update(undefined, briefUpdate);
    const e = ok(applyProjectDecision(p, { gate: p.gate, version: 1, verdict: "edit", edits: { brief: { users: "Kids", successCriteria: ["Fun"] } } }, { now: NOW })).project;
    expect(e.brief).toMatchObject({ version: 2, status: "draft", users: "Kids", successCriteria: ["Fun"], what: "A small puzzle game" });
    expect(e.gate).toEqual({ kind: "brief" });
  });

  it("a person's row edit changes worker and reviewer, re-estimates through the hook and bumps the version", () => {
    const p = update(approve(update(undefined, briefUpdate)), planUpdate);
    const e = ok(applyProjectDecision(
      p,
      { gate: p.gate, version: 1, verdict: "edit", edits: { rows: [{ taskId: "t1", worker: "cloud:model-c", reviewer: null }] } },
      { now: NOW, replan: (rows) => rows.map((r) => (r.taskId === "t1" ? { ...r, estCostUsd: 2, basis: "measured" as const } : r)) },
    )).project;
    expect(e.plan!.rows[0]).toMatchObject({ worker: "cloud:model-c", reviewer: null, estCostUsd: 2, basis: "measured" });
    expect(e.plan).toMatchObject({ version: 2, status: "draft", totals: { costUsd: 2.1 } });
  });

  it("a row edit without a hook clears the edited row's estimate", () => {
    const p = update(approve(update(undefined, briefUpdate)), planUpdate);
    const e = ok(applyProjectDecision(p, { gate: p.gate, version: 1, verdict: "edit", edits: { rows: [{ taskId: "t1", worker: "cloud:model-c" }] } }, { now: NOW })).project;
    expect(e.plan!.rows[0]).toMatchObject({ worker: "cloud:model-c", estCostUsd: null, estMs: null, basis: "preset", reason: "edited by the person" });
    expect(e.plan!.totals).toEqual({ costUsd: 0.1, ms: 1000, unknownCostRows: 1 });
  });

  it("an edit naming an unknown task is refused", () => {
    const p = update(approve(update(undefined, briefUpdate)), planUpdate);
    expect(applyProjectDecision(p, { gate: p.gate, version: 1, verdict: "edit", edits: { rows: [{ taskId: "zz", worker: "a:b" }] } }, { now: NOW }))
      .toMatchObject({ ok: false, error: { code: "invalid" } });
  });

  it("cheaper and quality need the replan hook and replace the rows", () => {
    const p = update(approve(update(undefined, briefUpdate)), planUpdate);
    expect(applyProjectDecision(p, { gate: p.gate, version: 1, verdict: "cheaper" }, { now: NOW }))
      .toMatchObject({ ok: false, error: { code: "needs-estimates" } });
    const seen: string[] = [];
    const c = ok(applyProjectDecision(p, { gate: p.gate, version: 1, verdict: "quality" }, {
      now: NOW,
      replan: (rows, verdict) => { seen.push(verdict); return rows.map((r) => ({ ...r, worker: "cloud:best", estCostUsd: 1 })); },
    })).project;
    expect(seen).toEqual(["quality"]);
    expect(c.plan!.rows.every((r) => r.worker === "cloud:best")).toBe(true);
    expect(c.plan).toMatchObject({ version: 2, status: "draft", totals: { costUsd: 2 } });
  });

  it("cancel at the brief gate marks the project cancelled", () => {
    const p = update(undefined, briefUpdate);
    const c = ok(applyProjectDecision(p, { gate: p.gate, version: 1, verdict: "cancel" }, { now: NOW })).project;
    expect(c).toMatchObject({ cancelledAt: NOW, gate: { kind: "none" } });
    expect(projectExpectation(c)).toEqual({ kind: "cancelled" });
  });

  it("cancel of the plan sets it cancelled", () => {
    const p = update(approve(update(undefined, briefUpdate)), planUpdate);
    const c = ok(applyProjectDecision(p, { gate: p.gate, version: 1, verdict: "cancel" }, { now: NOW })).project;
    expect(c.plan?.status).toBe("cancelled");
    expect(c.cancelledAt).toBe(NOW);
  });
});

describe("projectExpectation", () => {
  it("covers every stage", () => {
    expect(projectExpectation(undefined)).toEqual({ kind: "draft_brief" });
    const drafted = update(undefined, briefUpdate);
    expect(projectExpectation(drafted)).toEqual({ kind: "await_person", gate: { kind: "brief" } });
    let p = update(running(), { kind: "milestone_run", id: "m1", runId: "r" });
    expect(projectExpectation(p)).toEqual({ kind: "run_milestone", id: "m1" });
    p = update(p, { kind: "milestone", id: "m1", state: "done", summary: "s" });
    expect(projectExpectation(p)).toEqual({ kind: "await_person", gate: { kind: "milestone", id: "m1" } });
  });
});

describe("planTotals", () => {
  it("sums known costs, counts unknown ones and adds times", () => {
    expect(planTotals([row("a", "m"), row("b", "m", { estCostUsd: null, estMs: null })])).toEqual({ costUsd: 0.1, ms: 1000, unknownCostRows: 1 });
    expect(planTotals([row("a", "m", { estCostUsd: null, estMs: null })])).toEqual({ costUsd: null, ms: null, unknownCostRows: 1 });
  });
});

describe("normalizeProject", () => {
  it("round-trips a valid project", () => {
    const p = update(running(), { kind: "milestone_run", id: "m1", runId: "r" });
    expect(normalizeProject(JSON.parse(JSON.stringify(p)))).toEqual(p);
  });

  it.each([
    null,
    42,
    [],
    { milestones: [], gate: { kind: "weird" } },
    { milestones: "x", gate: { kind: "none" } },
    { milestones: [], gate: { kind: "brief" } },
    { milestones: [], gate: { kind: "milestone", id: "m9" } },
  ])("drops malformed %j", (raw) => {
    expect(normalizeProject(raw)).toBeUndefined();
  });

  it("drops a project whose brief has a bad status or whose rows name a missing milestone", () => {
    const p = JSON.parse(JSON.stringify(running())) as Record<string, any>;
    expect(normalizeProject({ ...p, brief: { ...p.brief, status: "maybe" } })).toBeUndefined();
    expect(normalizeProject({ ...p, plan: { ...p.plan, rows: [{ ...p.plan.rows[0], milestoneId: "zz" }] } })).toBeUndefined();
  });

  it("clips long strings and over-long arrays", () => {
    const p = JSON.parse(JSON.stringify(update(undefined, briefUpdate))) as Record<string, any>;
    p.brief.what = "y".repeat(PROJECT_LIMITS.text * 2);
    p.brief.successCriteria = Array.from({ length: PROJECT_LIMITS.successCriteria + 5 }, (_, i) => `c${i}`);
    const n = normalizeProject(p)!;
    expect(n.brief!.what.length).toBe(PROJECT_LIMITS.text);
    expect(n.brief!.successCriteria).toHaveLength(PROJECT_LIMITS.successCriteria);
  });
});

describe("session wiring", () => {
  it("withProject sets and removes; readProject reads", () => {
    const s = createEmptySessionState({ id: "s", workingDir: "/w" });
    expect(readProject(s)).toBeUndefined();
    expect(withProject(s, undefined)).toBe(s);
    const p = update(undefined, briefUpdate);
    const s2 = withProject(s, p);
    expect(readProject(s2)).toBe(p);
    expect("project" in withProject(s2, undefined)).toBe(false);
  });

  it("normalizeSessionState keeps a valid project, drops a malformed one and accepts sessions without one", () => {
    const s = withProject(createEmptySessionState({ id: "s", workingDir: "/w" }), running());
    const back = normalizeSessionState(JSON.parse(JSON.stringify(s)));
    expect(back.project).toEqual(s.project);
    const bad = normalizeSessionState({ ...JSON.parse(JSON.stringify(s)), project: { gate: 1 } });
    expect("project" in bad).toBe(false);
    const old = normalizeSessionState(JSON.parse(JSON.stringify(createEmptySessionState({ id: "o", workingDir: "/w" }))));
    expect(old.project).toBeUndefined();
  });
});
