import { describe, expect, it } from "vitest";

import {
  PROJECT_LIMITS,
  allowedProjectVerdicts,
  applyProjectDecision,
  applyProjectUpdate,
  criteriaById,
  gateVersion,
  milestoneShotsDir,
  validateMilestoneAttachments,
  normalizeProject,
  planTotals,
  projectExpectation,
  projectVerdictResets,
  readProject,
  withProject,
  type AssignmentRow,
  type ProjectCriterion,
  type ProjectState,
  type ProjectUpdate,
} from "./session-project.js";
import { createEmptySessionState } from "./session-state.js";
import { normalizeSessionState } from "./normalize-session-state.js";
import { join, resolve } from "node:path";
import { userTurn } from "./conversation-turn.js";
import {
  PROJECT_INSTRUCTIONS_MAX_CHARS,
  SESSION_PROJECT_METADATA_KEY,
  applySessionProject,
  parseProjectFields,
  readSessionProject,
  renderSessionProjectBody,
} from "./session-project.js";
import { buildPrompt, PROJECT_SECTION_MAX_TOKENS } from "../prompt/build-prompt.js";
import type { BuildPromptInput } from "../prompt/build-prompt-types.js";
import { estimateTokens } from "../prompt/token-budget.js";

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
    expect(p.brief?.successCriteria).toEqual([
      { id: "c1", text: "Runs in the browser" },
      { id: "c2", text: "Has three levels" },
    ]);
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
    // (The edited reviewer is marked as the person's, kept by variants.)
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
    let p = update(running(), { kind: "milestone_run", id: "m1", runId: "r1", startedAt: NOW + 10 }, NOW + 20);
    p = update(p, { kind: "milestone_run", id: "m1", runId: "r1" });
    p = update(p, { kind: "milestone_run", id: "m1", runId: "r2" });
    expect(p.milestones[0]).toMatchObject({ state: "in_progress", runIds: ["r1", "r2"] });
    expect(p.milestones[0]?.evidenceSince).toBe(NOW + 10);
  });

  it("a report records the summary, opens the milestone gate and bumps the plan version without un-approving it", () => {
    const r = running();
    const p = update(update(r, { kind: "milestone_run", id: "m1", runId: "r1" }), { kind: "milestone", id: "m1", state: "done", summary: "Base done" }, NOW + 5);
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
    let p = update(update(running(), { kind: "milestone_run", id: "m1", runId: "r1" }), { kind: "milestone", id: "m1", state: "done", summary: "ok" });
    p = approve(p);
    expect(p.milestones.map((m) => m.state)).toEqual(["reviewed", "approved"]);
    expect(projectExpectation(p)).toEqual({ kind: "run_milestone", id: "m2" });
    p = update(update(p, { kind: "milestone_run", id: "m2", runId: "r2" }), { kind: "milestone", id: "m2", state: "done", summary: "ok" });
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
    const reported = update(update(running(), { kind: "milestone_run", id: "m1", runId: "r1" }), { kind: "milestone", id: "m1", state: "done", summary: "ok" });
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
    expect(e.brief).toMatchObject({ version: 2, status: "draft", users: "Kids", successCriteria: [{ id: "c1", text: "Fun" }], what: "A small puzzle game" });
    expect(e.gate).toEqual({ kind: "brief" });
  });

  it("a person's row edit changes worker and reviewer, re-estimates through the hook and bumps the version", () => {
    const p = update(approve(update(undefined, briefUpdate)), planUpdate);
    const e = ok(applyProjectDecision(
      p,
      { gate: p.gate, version: 1, verdict: "edit", edits: { rows: [{ taskId: "t1", worker: "cloud:model-c", reviewer: null }] } },
      { now: NOW, replan: (rows) => rows.map((r) => (r.taskId === "t1" ? { ...r, estCostUsd: 2, basis: "measured" as const } : r)) },
    )).project;
    expect(e.plan!.rows[0]).toMatchObject({ worker: "cloud:model-c", reviewer: null, reviewerByPerson: true, estCostUsd: 2, basis: "measured" });
    expect(e.plan!.rows[1]!.reviewerByPerson).toBeUndefined();
    expect(e.plan).toMatchObject({ version: 2, status: "draft", totals: { costUsd: 2.1 } });
    // Stored and read back; a director's new plan starts without it.
    expect(normalizeProject(JSON.parse(JSON.stringify(e)))!.plan!.rows[0]!.reviewerByPerson).toBe(true);
    const sneaky = { ...planUpdate, rows: [{ ...row("t1", "m1"), reviewerByPerson: true }, row("t2", "m2")] } as ProjectUpdate;
    expect(update(approve(update(undefined, briefUpdate)), sneaky).plan!.rows[0]!.reviewerByPerson).toBeUndefined();
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

describe("a milestone gate cannot be skipped (issue #74)", () => {
  const failedReport = (): ProjectState => {
    const p = update(running(), { kind: "milestone_run", id: "m1", runId: "run-1" });
    return update(p, { kind: "milestone", id: "m1", state: "failed", summary: "broken" });
  };

  it("refuses a brief or plan re-draft while a milestone result waits for the person", () => {
    const p = failedReport();
    for (const u of [planUpdate, briefUpdate]) {
      const r = applyProjectUpdate(p, u, NOW);
      expect(r).toMatchObject({ ok: false, error: { code: "awaiting-person" } });
      if (!r.ok) expect(r.error.message).toMatch(/milestone m1.*wait for the person's decision/i);
    }
  });

  it("approving a plan never approves a later milestone past an unreviewed done or failed one", () => {
    for (const state of ["failed", "done"] as const) {
      const reported = update(update(running(), { kind: "milestone_run", id: "m1", runId: "run-1" }), { kind: "milestone", id: "m1", state, summary: "x" });
      // An older store: the plan gate reopened over the unreviewed result.
      const stored: ProjectState = { ...reported, plan: { ...reported.plan!, status: "draft" }, gate: { kind: "plan" } };
      const p = approve(stored);
      expect(p.milestones.map((m) => m.state)).toEqual([state, "planned"]);
      expect(p.gate).toEqual({ kind: "milestone", id: "m1" });
    }
  });

  it("a re-plan keeps a kept milestone's criteria facts and pictures", () => {
    let p = update(running(), { kind: "milestone_run", id: "m1", runId: "run-1" });
    p = update(p, { kind: "milestone", id: "m1", state: "done", summary: "ok", criteriaFacts: [{ id: "c1", state: "passed" }] });
    p = approve(p);
    const attachments = [{ path: "/state/fusion-runs/run-1/shots/a.png", caption: "Board" }];
    p = { ...p, milestones: p.milestones.map((m) => (m.id === "m1" ? { ...m, attachments } : m)) };
    const re = update(p, planUpdate);
    expect(re.milestones[0]).toMatchObject({ state: "reviewed", criteriaFacts: [{ id: "c1", state: "passed" }], attachments });
    expect(re.milestones[1]!.criteriaFacts).toBeUndefined();
  });
});

describe("a milestone is done only over a run (issue #74)", () => {
  it("refuses a done report with no run since its approval or since the last failed report", () => {
    const fresh = applyProjectUpdate(running(), { kind: "milestone", id: "m1", state: "done", summary: "ok" }, NOW);
    expect(fresh).toMatchObject({ ok: false, error: { code: "milestone-not-run" } });
    if (!fresh.ok) expect(fresh.error.message).toMatch(/fusion\.delegate/);
    // A failed report needs no run; a done one after it needs a new run.
    const failed = update(update(running(), { kind: "milestone_run", id: "m1", runId: "r1" }), { kind: "milestone", id: "m1", state: "failed", summary: "broken" });
    expect(applyProjectUpdate(failed, { kind: "milestone", id: "m1", state: "done", summary: "ok" }, NOW))
      .toMatchObject({ ok: false, error: { code: "milestone-not-run" } });
    // Re-approved after a correction: the old run no longer counts.
    const reapproved = approve(failed);
    expect(applyProjectUpdate(reapproved, { kind: "milestone", id: "m1", state: "done", summary: "ok" }, NOW))
      .toMatchObject({ ok: false, error: { code: "milestone-not-run" } });
    const rerun = update(reapproved, { kind: "milestone_run", id: "m1", runId: "r2" });
    expect(update(rerun, { kind: "milestone", id: "m1", state: "done", summary: "ok" }).milestones[0]).toMatchObject({ state: "done", runIds: ["r1", "r2"] });
    expect(update(running(), { kind: "milestone", id: "m1", state: "failed", summary: "could not start" }).milestones[0]!.state).toBe("failed");
  });
});

describe("a hard cap at a milestone gate does not stall the project (issue #74)", () => {
  const reported = (state: "done" | "failed"): ProjectState =>
    update(update(running(), { kind: "milestone_run", id: "m1", runId: "r1" }), { kind: "milestone", id: "m1", state, summary: "x" });
  const decide = (p: ProjectState, verdict: "approve" | "cheaper", hard: string[]) =>
    applyProjectDecision(p, { gate: p.gate, version: gateVersion(p)!, verdict }, { now: NOW, hardViolations: hard, replan: (rows) => rows.map((r) => ({ ...r, worker: "local:cheap" })) });

  it("approving a done result marks it reviewed; the next milestone over the cap waits at a plan gate the person can resolve", () => {
    const p = reported("done");
    const r = ok(decide(p, "approve", ["milestone m2 is over today's remaining limit"])).project;
    expect(r.milestones.map((m) => m.state)).toEqual(["reviewed", "planned"]);
    expect(r.gate).toEqual({ kind: "plan" });
    expect(r.plan).toMatchObject({ status: "draft", version: p.plan!.version + 1 });
    expect(allowedProjectVerdicts(r.gate)).toEqual(expect.arrayContaining(["cheaper", "quality", "edit"]));
    // The plan gate still refuses approval over the cap; cheaper resolves it, then approve starts m2.
    expect(decide(r, "approve", ["over"])).toMatchObject({ ok: false, error: { code: "over-cap" } });
    const cheaper = ok(decide(r, "cheaper", ["over"])).project;
    const started = approve(cheaper);
    expect(started.milestones.map((m) => m.state)).toEqual(["reviewed", "approved"]);
    expect(started.gate).toEqual({ kind: "none" });
  });

  it("approving a failed result over a cap keeps it for another run behind a plan gate", () => {
    const r = ok(decide(reported("failed"), "approve", ["a row's provider is not allowed"])).project;
    expect(r.milestones.map((m) => m.state)).toEqual(["planned", "planned"]);
    expect(r.gate).toEqual({ kind: "plan" });
    expect(approve(r).milestones.map((m) => m.state)).toEqual(["approved", "planned"]);
  });

  it("the last milestone's approval needs no further run: reviewed and done whatever the caps", () => {
    let p = approve(reported("done"));
    p = update(update(p, { kind: "milestone_run", id: "m2", runId: "r2" }), { kind: "milestone", id: "m2", state: "done", summary: "ok" });
    const r = ok(decide(p, "approve", ["over"])).project;
    expect(r.milestones.map((m) => m.state)).toEqual(["reviewed", "reviewed"]);
    expect(r.gate).toEqual({ kind: "none" });
  });
});

describe("one milestone open at a time (issue #74)", () => {
  it("a re-plan approved while a milestone runs does not approve the next one", () => {
    const runningM1 = update(running(), { kind: "milestone_run", id: "m1", runId: "r1" });
    const replanned = approve(update(runningM1, planUpdate));
    expect(replanned.milestones.map((m) => m.state)).toEqual(["in_progress", "planned"]);
    expect(applyProjectUpdate(replanned, { kind: "milestone_run", id: "m2", runId: "r2" }, NOW))
      .toMatchObject({ ok: false, error: { code: "milestone-not-approved" } });
  });

  it("a report is refused while another milestone's result waits for the person", () => {
    const runningM1 = update(running(), { kind: "milestone_run", id: "m1", runId: "r1" });
    // An older store with two open milestones: m1 reported, m2 running.
    const reported = update(runningM1, { kind: "milestone", id: "m1", state: "done", summary: "ok" });
    const both: ProjectState = { ...reported, milestones: reported.milestones.map((m) => (m.id === "m2" ? { ...m, state: "in_progress" as const, runIds: ["r2"] } : m)) };
    const r = applyProjectUpdate(both, { kind: "milestone", id: "m2", state: "failed", summary: "broken" }, NOW);
    expect(r).toMatchObject({ ok: false, error: { code: "awaiting-person" } });
    if (!r.ok) expect(r.error.message).toMatch(/milestone m1.s result waits/i);
    // The open milestone itself can still be re-reported.
    expect(update(both, { kind: "milestone", id: "m1", state: "done", summary: "ok, with pictures" }).gate).toEqual({ kind: "milestone", id: "m1" });
  });
});

describe("a re-plan keeps the person's reviewer pick (issue #74)", () => {
  it("carries reviewerByPerson for a row whose worker and reviewer are unchanged, and only then", () => {
    const p = running();
    const picked: ProjectState = {
      ...p,
      plan: { ...p.plan!, rows: p.plan!.rows.map((r) => ({ ...r, reviewer: null, reviewerByPerson: true as const })) },
    };
    const re = update(picked, {
      ...planUpdate,
      rows: [row("t1", "m1", { reviewer: null }), row("t2", "m2", { reviewer: "cloud:model-b" })],
    } as ProjectUpdate);
    expect(re.plan!.rows[0]).toMatchObject({ taskId: "t1", reviewer: null, reviewerByPerson: true });
    expect(re.plan!.rows[1]!.reviewerByPerson).toBeUndefined();
    // A director's row claiming the person's pick does not get one.
    const claimed = update(running(), { ...planUpdate, rows: [row("t1", "m1", { reviewerByPerson: true }), row("t2", "m2")] } as ProjectUpdate);
    expect(claimed.plan!.rows[0]!.reviewerByPerson).toBeUndefined();
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

describe("success criteria ids", () => {
  const withCriteria = (successCriteria: ReadonlyArray<string | ProjectCriterion>): ProjectUpdate => ({
    ...briefUpdate,
    brief: { ...briefUpdate.brief, successCriteria },
  });

  it("keeps given ids and gives plain strings the first free c<n>", () => {
    const p = update(undefined, withCriteria([{ id: "c2", text: "Runs offline" }, "Arrow keys steer", { id: "score-reset", text: "Score resets" }]));
    expect(p.brief!.successCriteria).toEqual([
      { id: "c2", text: "Runs offline" },
      { id: "c3", text: "Arrow keys steer" },
      { id: "score-reset", text: "Score resets" },
    ]);
  });

  it("lower-cases and trims an id; refuses a malformed, over-long or repeated one", () => {
    expect(update(undefined, withCriteria([{ id: " Plays-Well ", text: "x" }])).brief!.successCriteria[0]!.id).toBe("plays-well");
    for (const bad of [[{ id: "a b", text: "x" }], [{ id: "a_b", text: "x" }], [{ id: "x".repeat(33), text: "x" }], [{ id: "", text: "x" }],
      [{ id: "a", text: "x" }, { id: "A", text: "y" }], [{ id: "a", text: 3 }], [7]]) {
      expect(applyProjectUpdate(undefined, withCriteria(bad as never), NOW)).toMatchObject({ ok: false, error: { code: "invalid" } });
    }
  });

  it("a revision in plain strings keeps the id of a criterion whose text is unchanged", () => {
    const first = update(undefined, withCriteria([{ id: "offline", text: "Runs offline" }, { id: "keys", text: "Arrow keys steer" }]));
    const again = update(first, withCriteria(["Arrow keys steer", "Has sound"]));
    expect(again.brief!.successCriteria).toEqual([{ id: "keys", text: "Arrow keys steer" }, { id: "c2", text: "Has sound" }]);
  });

  it("an older stored brief with plain strings reads back with ids c1..cN and round-trips", () => {
    const stored = JSON.parse(JSON.stringify(update(undefined, briefUpdate))) as Record<string, any>;
    stored.brief.successCriteria = ["Runs in the browser", "Has three levels", "  "];
    const read = normalizeProject(stored)!;
    expect(read.brief!.successCriteria).toEqual([
      { id: "c1", text: "Runs in the browser" },
      { id: "c2", text: "Has three levels" },
    ]);
    expect(normalizeProject(JSON.parse(JSON.stringify(read)))).toEqual(read);
  });

  it("a stored list keeps the caps and repairs a bad or repeated id instead of dropping the project", () => {
    const stored = JSON.parse(JSON.stringify(update(undefined, briefUpdate))) as Record<string, any>;
    stored.brief.successCriteria = [
      { id: "a", text: "y".repeat(PROJECT_LIMITS.shortText + 20) },
      { id: "a", text: "two" },
      { id: "Bad Id", text: "three" },
      ...Array.from({ length: PROJECT_LIMITS.successCriteria }, (_, i) => `more ${i}`),
    ];
    const read = normalizeProject(stored)!;
    const list = read.brief!.successCriteria;
    expect(list).toHaveLength(PROJECT_LIMITS.successCriteria);
    expect(list[0]!.text.length).toBe(PROJECT_LIMITS.shortText);
    expect(new Set(list.map((c) => c.id)).size).toBe(list.length);
    expect(list.every((c) => /^[a-z0-9-]{1,32}$/.test(c.id))).toBe(true);
    expect(list[1]).toEqual({ id: "c2", text: "two" });
    expect(normalizeProject({ ...stored, brief: { ...stored.brief, successCriteria: [{ id: "a" }] } })).toBeUndefined();
  });

  it("criteriaById maps ids to criteria; empty without a brief", () => {
    const p = update(undefined, briefUpdate);
    const map = criteriaById(p.brief);
    expect([...map.keys()]).toEqual(["c1", "c2"]);
    expect(map.get("c2")).toEqual({ id: "c2", text: "Has three levels" });
    expect(criteriaById(undefined).size).toBe(0);
  });
});

describe("milestone attachments (issue #40)", () => {
  const STATE = resolve("/state-dir");
  const shot = (runId: string, file = "t1-1.jpg") => join(STATE, "fusion-runs", runId, "shots", file);
  const ran = (): ProjectState => update(running(), { kind: "milestone_run", id: "m1", runId: "run-1" });
  const report = (attachments: unknown[]): ProjectUpdate =>
    ({ kind: "milestone", id: "m1", state: "done", summary: "Board renders", attachments }) as ProjectUpdate;

  it("the shots folder of a run is <stateDir>/fusion-runs/<runId>/shots", () => {
    expect(milestoneShotsDir(STATE, "run-1")).toBe(join(STATE, "fusion-runs", "run-1", "shots"));
  });

  it("accepts a screenshot of a run recorded on the milestone, caption and criteria cleaned", () => {
    const m = ran().milestones[0]!;
    const checked = validateMilestoneAttachments({ stateDir: STATE, milestone: m, attachments: [{ path: shot("run-1"), caption: "  The board\n at start ", criteria: ["c1", "c1"] }], criterionIds: new Set(["c1"]) });
    expect(checked).toEqual({ ok: true, attachments: [{ path: shot("run-1"), caption: "The board at start", criteria: ["c1"] }] });
  });

  it.each([
    ["another run's shot", () => shot("run-9")],
    ["a path out of the shots folder", () => join(STATE, "fusion-runs", "run-1", "shots", "..", "run.json")],
    ["a file in a subfolder", () => join(STATE, "fusion-runs", "run-1", "shots", "sub", "a.jpg")],
    ["a relative path", () => "fusion-runs/run-1/shots/t1-1.jpg"],
    ["a non-image", () => shot("run-1", "t1-1.txt")],
    ["the folder itself", () => milestoneShotsDir(STATE, "run-1")],
  ])("refuses %s", (_label, path) => {
    const m = ran().milestones[0]!;
    const checked = validateMilestoneAttachments({ stateDir: STATE, milestone: m, attachments: [{ path: path(), caption: "x" }] });
    expect(checked.ok).toBe(false);
  });

  it("refuses more than the cap, a missing caption, an unknown criterion and a run id that is not one", () => {
    const m = ran().milestones[0]!;
    const many = Array.from({ length: PROJECT_LIMITS.attachments + 1 }, (_, i) => ({ path: shot("run-1", `t-${i}.jpg`), caption: "x" }));
    expect(validateMilestoneAttachments({ stateDir: STATE, milestone: m, attachments: many }).ok).toBe(false);
    expect(validateMilestoneAttachments({ stateDir: STATE, milestone: m, attachments: [{ path: shot("run-1") }] }).ok).toBe(false);
    expect(validateMilestoneAttachments({ stateDir: STATE, milestone: m, attachments: [{ path: shot("run-1"), caption: "x", criteria: ["zz"] }], criterionIds: new Set(["c1"]) }).ok).toBe(false);
    const odd = { ...m, runIds: [".."] };
    expect(validateMilestoneAttachments({ stateDir: STATE, milestone: odd, attachments: [{ path: join(STATE, "fusion-runs", "shots", "a.jpg"), caption: "x" }] }).ok).toBe(false);
  });

  it("a report stores checked attachments; without a state dir, or with a bad one, it is refused", () => {
    const p = ran();
    const done = ok(applyProjectUpdate(p, report([{ path: shot("run-1"), caption: "Board", criteria: ["c1"] }]), NOW, { stateDir: STATE })).project;
    expect(done.milestones[0]!.attachments).toEqual([{ path: shot("run-1"), caption: "Board", criteria: ["c1"] }]);
    expect(applyProjectUpdate(p, report([{ path: shot("run-1"), caption: "Board" }]), NOW)).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(applyProjectUpdate(p, report([{ path: shot("run-9"), caption: "Board" }]), NOW, { stateDir: STATE })).toMatchObject({ ok: false, error: { code: "invalid" } });
    // A new report without attachments drops the old result's.
    const again = update(done, { kind: "milestone", id: "m1", state: "failed", summary: "Broke" });
    expect(again.milestones[0]!.attachments).toBeUndefined();
  });

  it("a done report carries the runtime's criteria facts onto the milestone; a later report without them clears them", () => {
    const p = ran();
    const done = update(p, { kind: "milestone", id: "m1", state: "done", summary: "Board renders", criteriaFacts: [{ id: "c1", state: "passed", why: "ok" }, { id: "C2", state: "unverified" }] });
    expect(done.milestones[0]!.criteriaFacts).toEqual([{ id: "c1", state: "passed", why: "ok" }, { id: "c2", state: "unverified" }]);
    const again = update(done, { kind: "milestone", id: "m1", state: "failed", summary: "Broke" });
    expect(again.milestones[0]!.criteriaFacts).toBeUndefined();
  });

  it("stored attachments and criteria facts read back, malformed entries dropped, caps kept", () => {
    const p = ran();
    const withFacts = ok(applyProjectUpdate(p, {
      ...report([{ path: shot("run-1"), caption: "Board" }]),
      criteriaFacts: [{ id: "c1", state: "passed" }, { id: "c2", state: "unverified", why: "no vision reviewer" }],
    } as ProjectUpdate, NOW, { stateDir: STATE })).project;
    const raw = JSON.parse(JSON.stringify(withFacts)) as Record<string, any>;
    expect(normalizeProject(raw)).toEqual(withFacts);
    raw.milestones[0].attachments.push({ path: 3 }, ...Array.from({ length: 10 }, (_, i) => ({ path: shot("run-1", `x${i}.jpg`), caption: "c" })));
    raw.milestones[0].criteriaFacts.push({ id: "c3", state: "maybe" });
    const read = normalizeProject(raw)!;
    expect(read.milestones[0]!.attachments).toHaveLength(PROJECT_LIMITS.attachments);
    expect(read.milestones[0]!.criteriaFacts).toEqual([{ id: "c1", state: "passed" }, { id: "c2", state: "unverified", why: "no vision reviewer" }]);
  });

  it("a report's criteria facts are cleaned: one per id, clipped, malformed ones dropped", () => {
    const set = update(ran(), { kind: "milestone", id: "m1", state: "done", summary: "s", criteriaFacts: [{ id: "c1", state: "failed", why: "x".repeat(500) }, { id: "c1", state: "passed" }, { id: "bad id", state: "passed" } as never] });
    expect(set.milestones[0]!.criteriaFacts).toEqual([{ id: "c1", state: "failed", why: `${"x".repeat(PROJECT_LIMITS.shortText - 1)}…` }]);
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

const CAPS = { platform: "darwin", arch: "arm64", browserChannel: "chrome", workingDir: "/work",
  hasClipboard: false, hasWmctrl: false, hasNotifications: false } as const;

function input(mode?: "cloud"): BuildPromptInput {
  const session = createEmptySessionState({ id: "s", workingDir: "/work" });
  session.turns = [userTurn("hello", 1)];
  return {
    session, toolDescriptors: [], skillCatalog: [], capabilities: { ...CAPS },
    ...(mode ? {
      modelMode: { mode, source: "provider" as const, providerId: "remote", modelId: "large" },
      contextWindow: 200000, profileWindowApplies: false, toolTransport: "native_tools" as const,
      suppressReasoningPrefill: true,
    } : {}),
  };
}

describe("parseProjectFields (ATO-42)", () => {
  it("absent keeps, null and blank clear, a string stamps", () => {
    expect(parseProjectFields(undefined, "x")).toEqual({ ok: true, value: undefined });
    expect(parseProjectFields(null, "x")).toEqual({ ok: true, value: null });
    expect(parseProjectFields("  \n ", "x")).toEqual({ ok: true, value: null });
    expect(parseProjectFields("  Answer in French.  ", "  Site\nredesign ")).toEqual({
      ok: true, value: { name: "Site redesign", instructions: "Answer in French." },
    });
    expect(parseProjectFields("Rules", undefined)).toEqual({ ok: true, value: { name: null, instructions: "Rules" } });
  });

  it("refuses a wrong type or an oversized text instead of cutting it", () => {
    expect(parseProjectFields(42, null)).toMatchObject({ ok: false, param: "project_instructions" });
    expect(parseProjectFields("x".repeat(PROJECT_INSTRUCTIONS_MAX_CHARS + 1), null)).toMatchObject({ ok: false, param: "project_instructions" });
    expect(parseProjectFields("ok", { evil: true })).toMatchObject({ ok: false, param: "project_name" });
    expect(parseProjectFields("x".repeat(PROJECT_INSTRUCTIONS_MAX_CHARS), null)).toMatchObject({ ok: true });
  });

  it("cuts a long name by characters, never inside an emoji", () => {
    const res = parseProjectFields("Rules", "😀".repeat(100));
    expect(res.ok && res.value && Array.from(res.value.name ?? "")).toHaveLength(80);
  });
});

describe("session project stamp", () => {
  it("stamps, keeps on undefined, clears on null", () => {
    const s = createEmptySessionState({ id: "s", workingDir: "/w" });
    applySessionProject(s, { name: "P", instructions: "Use tabs." });
    expect(readSessionProject(s)).toEqual({ name: "P", instructions: "Use tabs." });
    applySessionProject(s, undefined);
    expect(readSessionProject(s)?.instructions).toBe("Use tabs.");
    applySessionProject(s, null);
    expect(SESSION_PROJECT_METADATA_KEY in s.metadata).toBe(false);
    expect(readSessionProject(s)).toBeNull();
  });

  it("survives a JSON round trip and ignores a stored value that is not a project", () => {
    const s = createEmptySessionState({ id: "s", workingDir: "/w" });
    applySessionProject(s, { name: null, instructions: "Be brief." });
    const back = JSON.parse(JSON.stringify(s));
    expect(readSessionProject(back)).toEqual({ name: null, instructions: "Be brief." });
    expect(readSessionProject({ metadata: { project: "nope" } })).toBeNull();
    expect(readSessionProject({ metadata: { project: { instructions: "  " } } })).toBeNull();
  });

  it("renders the name and the text, and nothing without a project", () => {
    const s = createEmptySessionState({ id: "s", workingDir: "/w" });
    expect(renderSessionProjectBody(s)).toBeNull();
    applySessionProject(s, { name: "Docs", instructions: "Write in English." });
    const body = renderSessionProjectBody(s)!;
    expect(body).toContain('the project "Docs"');
    expect(body).toContain("grant no tool permissions");
    expect(body.endsWith("Write in English.")).toBe(true);
  });
});

describe("project instructions in the prompt", () => {
  it("local: a ### project block ahead of the conversation, only when the chat has a project", () => {
    const plain = buildPrompt(input());
    expect(plain.text).not.toContain("### project");
    const i = input();
    applySessionProject(i.session, { name: "Docs", instructions: "PROJECT RULE 7" });
    const { text } = buildPrompt(i);
    expect(text).toContain("### project\n");
    expect(text).toContain("PROJECT RULE 7");
    expect(text.indexOf("### project\n")).toBeLessThan(text.indexOf("### conversation\n"));
  });

  it("local: a long text is capped so a small window keeps room", () => {
    const i = input();
    applySessionProject(i.session, { name: null, instructions: "word ".repeat(3000) + "TAIL END" });
    const { text } = buildPrompt(i);
    const block = text.slice(text.indexOf("### project\n") + "### project\n".length, text.indexOf("### world"));
    expect(text).not.toContain("TAIL END");
    expect(estimateTokens(block)).toBeLessThanOrEqual(PROJECT_SECTION_MAX_TOKENS + 8);
  });

  it("local: the built prompt reports the block, its full size and the cut", () => {
    const small = input();
    applySessionProject(small.session, { name: "Docs", instructions: "Short rule." });
    const uncut = buildPrompt(small).project;
    expect(uncut).toMatchObject({ name: "Docs", truncated: false });
    expect(uncut!.tokens).toBeGreaterThan(0);
    const big = input();
    applySessionProject(big.session, { name: null, instructions: "word ".repeat(3000) });
    const cut = buildPrompt(big).project!;
    expect(cut.truncated).toBe(true);
    expect(cut.name).toBeNull();
    expect(cut.tokens).toBeGreaterThan(PROJECT_SECTION_MAX_TOKENS);
    expect(buildPrompt(input()).project).toBeUndefined();
  });

  it("cloud: the full text as a project section", () => {
    const i = input("cloud");
    applySessionProject(i.session, { name: "Docs", instructions: "word ".repeat(3000) + "TAIL END" });
    const { text } = buildPrompt(i);
    expect(text).toContain("TAIL END");
    expect(text).toContain('the project "Docs"');
  });
});

describe("a re-plan that changes a milestone's work drops its verdict (issue #77)", () => {
  /** m1 run, reported done with evidence and a correction, then reviewed. */
  const reviewedM1 = (): ProjectState => {
    let p = update(running(), { kind: "milestone_run", id: "m1", runId: "run-1" });
    p = update(p, { kind: "milestone", id: "m1", state: "done", summary: "Base works", criteriaFacts: [{ id: "c1", state: "passed" }] });
    const attachments = [{ path: "/state/fusion-runs/run-1/shots/a.png", caption: "Board" }];
    p = { ...p, milestones: p.milestones.map((m) => (m.id === "m1" ? { ...m, attachments, corrections: [{ note: "tidy", at: NOW }] } : m)) };
    return approve(p);
  };

  it("new title, kind and task: the approved plan shows the new work as not reviewed, old evidence in history", () => {
    const p = reviewedM1();
    const re = approve(
      update(
        p,
        {
          ...planUpdate,
          milestones: [{ id: "m1", title: "Physics", kind: "logic" }, planUpdate.milestones[1]!],
          rows: [row("t9", "m1", { title: "Write the physics" }), row("t2", "m2")],
        } as ProjectUpdate,
        NOW + 5,
      ),
      NOW + 6,
    );
    const m1 = re.milestones[0]!;
    expect(m1).toMatchObject({ id: "m1", title: "Physics", kind: "logic", state: "approved", runIds: [] });
    for (const field of ["summary", "attachments", "criteriaFacts", "corrections"] as const) expect(m1[field]).toBeUndefined();
    // A lean record: the work's titles, runs, a capped summary, the facts; counts for corrections and pictures.
    expect(m1.history).toEqual([
      {
        title: "Base",
        kind: "base",
        state: "reviewed",
        tasks: ["Task t1"],
        runIds: ["run-1"],
        summary: "Base works",
        criteriaFacts: [{ id: "c1", state: "passed" }],
        correctionCount: 1,
        attachmentCount: 1,
        criteria: [{ id: "c1", text: "Runs in the browser" }],
        cause: "plan",
        supersededAt: NOW + 5,
      },
    ]);
    // The person approving is told.
    const draft = update(p, { ...planUpdate, milestones: [{ id: "m1", title: "Physics", kind: "logic" }, planUpdate.milestones[1]!], rows: [row("t9", "m1", { title: "Write the physics" }), row("t2", "m2")] } as ProjectUpdate);
    expect(draft.plan!.verdictResets).toEqual(["m1"]);
    expect(projectVerdictResets(p, { ...planUpdate, milestones: [{ id: "m1", title: "Physics", kind: "logic" }, planUpdate.milestones[1]!], rows: [row("t9", "m1", { title: "Write the physics" }), row("t2", "m2")] } as ProjectUpdate)).toEqual(["Physics"]);
    expect(re.plan!.verdictResets).toBeUndefined();
    // Attachments of the old runs cannot ride on a new report.
    expect(
      validateMilestoneAttachments({
        stateDir: "/state",
        milestone: m1,
        attachments: [{ path: "/state/fusion-runs/run-1/shots/a.png", caption: "Board" }],
        criterionIds: new Set(["c1"]),
      }).ok,
    ).toBe(false);
  });

  it.each([
    ["the kind", { milestones: [{ id: "m1", title: "Base", kind: "logic" }, planUpdate.milestones[1]!], rows: [row("t1", "m1"), row("t2", "m2")] }],
    ["a task's title", { milestones: planUpdate.milestones, rows: [row("t1", "m1", { title: "Something else" }), row("t2", "m2")] }],
    ["an added task", { milestones: planUpdate.milestones, rows: [row("t1", "m1"), row("t3", "m1"), row("t2", "m2")] }],
    ["a task moved away", { milestones: planUpdate.milestones, rows: [row("t1", "m2"), row("t2", "m2")] }],
  ])("changing %s is material", (_label, change) => {
    const re = update(reviewedM1(), { ...planUpdate, ...change } as ProjectUpdate);
    expect(re.milestones[0]).toMatchObject({ state: "planned", runIds: [] });
    expect(re.milestones[0]!.summary).toBeUndefined();
    expect(re.milestones[0]!.history).toHaveLength(1);
  });

  it("an editorial change (milestone title, whitespace or case of a task title, worker, order) keeps the verdict", () => {
    const re = update(reviewedM1(), {
      ...planUpdate,
      milestones: [planUpdate.milestones[1]!, { id: "m1", title: "Base layer, renamed", kind: "base" }],
      rows: [row("t2", "m2"), row("t1", "m1", { title: "  task   T1 ", worker: "cloud:other" })],
    } as ProjectUpdate);
    const m1 = re.milestones.find((m) => m.id === "m1")!;
    expect(m1).toMatchObject({ title: "Base layer, renamed", state: "reviewed", runIds: ["run-1"], summary: "Base works", criteriaFacts: [{ id: "c1", state: "passed" }] });
    expect(m1.attachments).toHaveLength(1);
    expect(m1.history).toBeUndefined();
  });

  it("work without a verdict keeps its runs when the re-plan only adds tasks; any other change resets it", () => {
    const inProgress = update(running(), { kind: "milestone_run", id: "m1", runId: "run-1" });
    const added = update(inProgress, { ...planUpdate, rows: [row("t1", "m1"), row("t3", "m1"), row("t2", "m2")] } as ProjectUpdate);
    expect(added.milestones[0]).toMatchObject({ state: "in_progress", runIds: ["run-1"] });
    expect(added.milestones[0]!.history).toBeUndefined();
    // The run still counts: the result can be reported done after the approval.
    const approved = approve(added);
    expect(applyProjectUpdate(approved, { kind: "milestone", id: "m1", state: "done", summary: "ok" }, NOW)).toMatchObject({ ok: true });
    // An approved milestone holding a failed try's runs keeps them too.
    let failed = update(running(), { kind: "milestone_run", id: "m1", runId: "run-1" });
    failed = approve(update(failed, { kind: "milestone", id: "m1", state: "failed", summary: "broken" }));
    const failedAdded = update(failed, { ...planUpdate, rows: [row("t1", "m1"), row("t3", "m1"), row("t2", "m2")] } as ProjectUpdate);
    expect(failedAdded.milestones[0]).toMatchObject({ state: "planned", runIds: ["run-1"] });
    // A removal, a changed title or a new kind still resets running work.
    for (const change of [
      { rows: [row("t3", "m1"), row("t2", "m2")] },
      { milestones: [{ id: "m1", title: "Base", kind: "logic" }, planUpdate.milestones[1]!], rows: [row("t1", "m1"), row("t3", "m1"), row("t2", "m2")] },
    ]) {
      const re = update(inProgress, { ...planUpdate, ...change } as ProjectUpdate);
      expect(re.milestones[0]).toMatchObject({ state: "planned", runIds: [] });
      expect(re.milestones[0]!.history?.[0]).toMatchObject({ state: "in_progress", runIds: ["run-1"] });
    }
    // A reviewed milestone has a verdict: an added task resets it.
    expect(update(reviewedM1(), { ...planUpdate, rows: [row("t1", "m1"), row("t3", "m1"), row("t2", "m2")] } as ProjectUpdate).milestones[0])
      .toMatchObject({ state: "planned", runIds: [] });
  });

  it("a task renamed to a new id with the same title is not a change of work", () => {
    const re = update(reviewedM1(), { ...planUpdate, rows: [row("t1-renamed", "m1", { title: "Task t1" }), row("t2", "m2")] } as ProjectUpdate);
    expect(re.milestones[0]).toMatchObject({ state: "reviewed", runIds: ["run-1"], summary: "Base works" });
    expect(re.milestones[0]!.history).toBeUndefined();
  });

  it("an approved milestone with runs of a failed try drops them when its work changes", () => {
    let p = update(running(), { kind: "milestone_run", id: "m1", runId: "run-1" });
    p = approve(update(p, { kind: "milestone", id: "m1", state: "failed", summary: "broken" }));
    expect(p.milestones[0]).toMatchObject({ state: "approved", runIds: ["run-1"] });
    const re = update(p, { ...planUpdate, rows: [row("t5", "m1", { title: "Other work" }), row("t2", "m2")] } as ProjectUpdate);
    expect(re.milestones[0]).toMatchObject({ state: "planned", runIds: [] });
    expect(re.milestones[0]!.summary).toBeUndefined();
    expect(re.milestones[0]!.history?.[0]).toMatchObject({ state: "approved", runIds: ["run-1"], summary: "broken" });
  });

  it("a brief that changes a criterion's text resets the milestones whose facts cite it; a case or spacing edit does not", () => {
    const criteria = (c1: string) => ({ ...briefUpdate, brief: { ...briefUpdate.brief, successCriteria: [{ id: "c1", text: c1 }, { id: "c2", text: "Has three levels" }] } }) as ProjectUpdate;
    // A draft alone resets nothing; the approval does.
    expect(update(reviewedM1(), criteria("Runs offline on Windows")).milestones[0]).toMatchObject({ state: "reviewed" });
    const changed = approve(update(reviewedM1(), criteria("Runs offline on Windows")), NOW + 3);
    expect(changed.milestones[0]).toMatchObject({ state: "planned", runIds: [] });
    expect(changed.milestones[0]!.criteriaFacts).toBeUndefined();
    expect(changed.milestones[0]!.history?.[0]).toMatchObject({ state: "reviewed", runIds: ["run-1"], criteriaFacts: [{ id: "c1", state: "passed" }], cause: "brief", supersededAt: NOW + 3 });
    expect(changed.plan!.verdictResets).toEqual(["m1"]);
    const edited = approve(update(reviewedM1(), criteria("  runs in THE browser ")));
    expect(edited.milestones[0]).toMatchObject({ state: "reviewed", runIds: ["run-1"], criteriaFacts: [{ id: "c1", state: "passed" }] });
    expect(edited.milestones[0]!.history).toBeUndefined();
    // A change to a criterion no fact cites leaves the verdict.
    const other = approve(update(reviewedM1(), { ...briefUpdate, brief: { ...briefUpdate.brief, successCriteria: [{ id: "c1", text: "Runs in the browser" }, { id: "c2", text: "Has ten levels" }] } } as ProjectUpdate));
    expect(other.milestones[0]).toMatchObject({ state: "reviewed" });
  });

  it("removing a criterion keeps the verdict: only its facts and pictures go, to history with its text (issue #80)", () => {
    let p = update(running(), { kind: "milestone_run", id: "m1", runId: "run-1" });
    p = update(p, { kind: "milestone", id: "m1", state: "done", summary: "Base works", criteriaFacts: [{ id: "c1", state: "passed" }, { id: "c2", state: "passed" }] });
    const shot = (name: string, criteria?: string[]) => ({ path: `/state/fusion-runs/run-1/shots/${name}.png`, caption: name, ...(criteria === undefined ? {} : { criteria }) });
    p = { ...p, milestones: p.milestones.map((m) => (m.id === "m1" ? { ...m, attachments: [shot("only-c1", ["c1"]), shot("both", ["c1", "c2"]), shot("none")] } : m)) };
    p = approve(p);
    const dropC1 = { ...briefUpdate, brief: { ...briefUpdate.brief, successCriteria: [{ id: "c2", text: "Has three levels" }] } } as ProjectUpdate;
    const after = approve(update(p, dropC1, NOW + 7), NOW + 8);
    const m1 = after.milestones[0]!;
    expect(m1).toMatchObject({ state: "reviewed", runIds: ["run-1"], summary: "Base works", criteriaFacts: [{ id: "c2", state: "passed" }] });
    expect(m1.attachments).toEqual([shot("both", ["c2"]), shot("none")]);
    expect(m1.history).toEqual([
      expect.objectContaining({
        state: "reviewed",
        cause: "brief-removed",
        criteriaFacts: [{ id: "c1", state: "passed" }],
        criteria: [{ id: "c1", text: "Runs in the browser" }],
        attachmentCount: 1,
      }),
    ]);
    expect(after.plan!.verdictResets).toBeUndefined();
  });

  it("removing the only criterion a milestone cites keeps its state; its facts go to history", () => {
    const dropC1 = { ...briefUpdate, brief: { ...briefUpdate.brief, successCriteria: [{ id: "c2", text: "Has three levels" }] } } as ProjectUpdate;
    const after = approve(update(reviewedM1(), dropC1));
    const m1 = after.milestones[0]!;
    expect(m1).toMatchObject({ state: "reviewed", runIds: ["run-1"], summary: "Base works" });
    expect(m1.criteriaFacts).toBeUndefined();
    expect(m1.history?.at(-1)).toMatchObject({ cause: "brief-removed", criteriaFacts: [{ id: "c1", state: "passed" }], criteria: [{ id: "c1", text: "Runs in the browser" }] });
  });

  it("criteria are judged at the brief's approval against the last approved one: a draft that drops one and a draft that restores it change nothing", () => {
    const p = reviewedM1();
    const v2 = update(p, { ...briefUpdate, brief: { ...briefUpdate.brief, successCriteria: [{ id: "c2", text: "Has three levels" }] } } as ProjectUpdate);
    expect(v2.milestones[0]).toMatchObject({ state: "reviewed", criteriaFacts: [{ id: "c1", state: "passed" }] });
    const v3 = update(v2, { ...briefUpdate, brief: { ...briefUpdate.brief, successCriteria: [{ id: "c1", text: "Runs in the browser" }, { id: "c2", text: "Has three levels" }] } } as ProjectUpdate);
    const after = approve(v3);
    expect(after.milestones[0]).toMatchObject({ state: "reviewed", runIds: ["run-1"], criteriaFacts: [{ id: "c1", state: "passed" }] });
    expect(after.milestones[0]!.history).toBeUndefined();
  });

  it("without an approved brief to compare with, an approval retires every criteria fact but keeps the verdict (issue #83)", () => {
    const draft = update(reviewedM1(), { ...briefUpdate, brief: { ...briefUpdate.brief, successCriteria: [{ id: "c2", text: "Has three levels" }] } } as ProjectUpdate);
    // An older store mid-draft: no record of the approved criteria.
    const { approvedCriteria: _gone, ...older } = draft;
    const after = approve(older as ProjectState);
    expect(after.milestones[0]).toMatchObject({ state: "reviewed", runIds: ["run-1"] });
    expect(after.milestones[0]!.criteriaFacts).toBeUndefined();
    expect(after.milestones[0]!.history?.at(-1)).toMatchObject({ cause: "brief-removed", unknownCriteria: ["c1"], criteriaFacts: [{ id: "c1", state: "passed" }] });
    expect(after.plan!.evidenceRetired).toEqual(["m1"]);
    expect(after.approvedCriteria).toEqual([{ id: "c2", text: "Has three levels" }]);
  });

  describe("a milestone left with no evidence is named at the plan gate (issue #83)", () => {
    /** m1 reviewed with exactly this evidence; the brief approved with c1, c2. */
    const reviewedWith = (evidence: { criteriaFacts?: ProjectState["milestones"][number]["criteriaFacts"]; attachments?: ProjectState["milestones"][number]["attachments"] }): ProjectState => {
      let p = update(running(), { kind: "milestone_run", id: "m1", runId: "run-1" });
      p = update(p, { kind: "milestone", id: "m1", state: "done", summary: "Base works" });
      p = { ...p, milestones: p.milestones.map((m) => (m.id === "m1" ? { ...m, ...evidence } : m)) };
      return approve(p);
    };
    const sameBrief = { ...briefUpdate, brief: { ...briefUpdate.brief, successCriteria: [{ id: "c1", text: "Runs in the browser" }, { id: "c2", text: "Has three levels" }] } } as ProjectUpdate;

    it("its only evidence, a picture citing an orphan id, is retired: the verdict stays and the plan gate names it", () => {
      const p = reviewedWith({ attachments: [{ path: "/state/fusion-runs/run-1/shots/x.png", caption: "x", criteria: ["zz"] }] });
      const after = approve(update(p, sameBrief));
      const m1 = after.milestones[0]!;
      expect(m1).toMatchObject({ state: "reviewed", runIds: ["run-1"] });
      expect(m1.attachments).toBeUndefined();
      expect(m1.history?.at(-1)).toMatchObject({ cause: "brief-removed", unknownCriteria: ["zz"], attachmentCount: 1 });
      expect(after.plan!.evidenceRetired).toEqual(["m1"]);
    });

    it("its only evidence, the facts of a removed criterion, is retired: named too", () => {
      const p = reviewedWith({ criteriaFacts: [{ id: "c1", state: "passed" }] });
      const after = approve(update(p, { ...briefUpdate, brief: { ...briefUpdate.brief, successCriteria: [{ id: "c2", text: "Has three levels" }] } } as ProjectUpdate));
      expect(after.milestones[0]).toMatchObject({ state: "reviewed" });
      expect(after.milestones[0]!.criteriaFacts).toBeUndefined();
      expect(after.plan!.evidenceRetired).toEqual(["m1"]);
    });

    it("a failed fact on an orphan id is retired and never turns into a pass; evidence left: not named", () => {
      const p = reviewedWith({ criteriaFacts: [{ id: "c1", state: "passed" }, { id: "zz", state: "failed", why: "check red" }] });
      const after = approve(update(p, sameBrief));
      const m1 = after.milestones[0]!;
      expect(m1.criteriaFacts).toEqual([{ id: "c1", state: "passed" }]);
      expect(m1.history?.at(-1)).toMatchObject({ cause: "brief-removed", unknownCriteria: ["zz"], criteriaFacts: [{ id: "zz", state: "failed", why: "check red" }] });
      expect(JSON.stringify(after.milestones)).not.toMatch(/"id":"zz","state":"passed"/);
      expect(after.plan!.evidenceRetired).toBeUndefined();
    });
  });

  it("the person's brief edit is judged at approval: a changed text resets, a removal retires the facts", () => {
    const atGate = update(reviewedM1(), briefUpdate);
    const edit = (successCriteria: ProjectCriterion[]) => {
      const r = applyProjectDecision(atGate, { gate: { kind: "brief" }, version: gateVersion(atGate)!, verdict: "edit", edits: { brief: { successCriteria } } }, { now: NOW });
      return approve(ok(r).project);
    };
    const changed = edit([{ id: "c1", text: "Runs offline on Windows" }, { id: "c2", text: "Has three levels" }]);
    expect(changed.milestones[0]).toMatchObject({ state: "planned", runIds: [] });
    expect(changed.milestones[0]!.history?.at(-1)).toMatchObject({ cause: "brief", state: "reviewed", criteriaFacts: [{ id: "c1", state: "passed" }], criteria: [{ id: "c1", text: "Runs in the browser" }] });
    expect(changed.plan!.verdictResets).toEqual(["m1"]);
    const removed = edit([{ id: "c2", text: "Has three levels" }]);
    expect(removed.milestones[0]).toMatchObject({ state: "reviewed", runIds: ["run-1"] });
    expect(removed.milestones[0]!.criteriaFacts).toBeUndefined();
    expect(removed.milestones[0]!.history?.at(-1)).toMatchObject({ cause: "brief-removed", criteriaFacts: [{ id: "c1", state: "passed" }] });
  });

  it("two milestones that swap ids with their tasks both start over; neither inherits the other's result", () => {
    let p = reviewedM1();
    p = update(p, { kind: "milestone_run", id: "m2", runId: "run-2" });
    p = approve(update(p, { kind: "milestone", id: "m2", state: "done", summary: "UI works" }));
    const re = update(p, {
      ...planUpdate,
      milestones: [{ id: "m1", title: "UI", kind: "ui" }, { id: "m2", title: "Base", kind: "base" }],
      rows: [row("t2", "m1"), row("t1", "m2")],
    } as ProjectUpdate);
    for (const [i, was] of [["run-1", "Base works"], ["run-2", "UI works"]].entries()) {
      expect(re.milestones[i]).toMatchObject({ state: "planned", runIds: [] });
      expect(re.milestones[i]!.summary).toBeUndefined();
      expect(re.milestones[i]!.history).toEqual([expect.objectContaining({ runIds: [was[0]], summary: was[1] })]);
    }
    expect(re.plan!.verdictResets).toEqual(["m1", "m2"]);
  });

  it("keeps the newest 4 revisions", () => {
    let p = reviewedM1();
    for (let round = 1; round <= 5; round++) {
      p = approve(update(p, { ...planUpdate, rows: [row("t1", "m1", { title: `Work ${round}` }), row("t2", "m2")] } as ProjectUpdate, NOW + round));
      p = update(p, { kind: "milestone_run", id: "m1", runId: `run-r${round}` });
      p = approve(update(p, { kind: "milestone", id: "m1", state: "done", summary: `round ${round}` }));
    }
    const history = p.milestones[0]!.history!;
    expect(history).toHaveLength(PROJECT_LIMITS.history);
    expect(history.map((h) => h.supersededAt)).toEqual([NOW + 2, NOW + 3, NOW + 4, NOW + 5]);
    expect(history.map((h) => h.summary)).toEqual(["round 1", "round 2", "round 3", "round 4"]);
    expect(normalizeProject(JSON.parse(JSON.stringify(p)))!.milestones[0]!.history).toEqual(history);
  });

  it("one re-plan: an editorial edit keeps m1's verdict while a material change resets m2", () => {
    let p = reviewedM1();
    p = update(p, { kind: "milestone_run", id: "m2", runId: "run-2" });
    p = approve(update(p, { kind: "milestone", id: "m2", state: "done", summary: "UI works" }));
    const re = update(p, {
      ...planUpdate,
      milestones: [{ id: "m1", title: "Base, renamed", kind: "base" }, { id: "m2", title: "UI", kind: "ui" }],
      rows: [row("t1-new-id", "m1", { title: " TASK t1" }), row("t2", "m2", { title: "A settings screen" })],
    } as ProjectUpdate);
    expect(re.milestones[0]).toMatchObject({ state: "reviewed", runIds: ["run-1"], summary: "Base works" });
    expect(re.milestones[0]!.history).toBeUndefined();
    expect(re.milestones[1]).toMatchObject({ state: "planned", runIds: [] });
    expect(re.milestones[1]!.summary).toBeUndefined();
    expect(re.plan!.verdictResets).toEqual(["m2"]);
  });

  it("history reads back from a stored session; older stores without it still read", () => {
    const re = update(reviewedM1(), { ...planUpdate, rows: [row("t5", "m1", { title: "Other work" }), row("t2", "m2")] } as ProjectUpdate);
    const back = normalizeProject(JSON.parse(JSON.stringify(re)));
    expect(back!.milestones[0]!.history).toEqual(re.milestones[0]!.history);
    const malformed = JSON.parse(JSON.stringify(re));
    malformed.milestones[0].history.push({ title: 3 }, "x");
    expect(normalizeProject(malformed)!.milestones[0]!.history).toEqual(re.milestones[0]!.history);
    const old = JSON.parse(JSON.stringify(reviewedM1()));
    expect(normalizeProject(old)!.milestones[0]!.history).toBeUndefined();
    // The first, richer revision shape still reads, as the lean one.
    const rich = JSON.parse(JSON.stringify(re));
    rich.milestones[0].history = [{
      title: "Base", kind: "base", state: "reviewed", tasks: [{ taskId: "t1", title: "Task t1" }], runIds: ["run-1"],
      summary: "x".repeat(3000), corrections: [{ note: "tidy", at: NOW }],
      attachments: [{ path: "/state/fusion-runs/run-1/shots/a.png", caption: "Board" }], criteriaFacts: [{ id: "c1", state: "passed" }], supersededAt: NOW,
    }];
    const lean = normalizeProject(rich)!.milestones[0]!.history![0]!;
    expect(lean).toMatchObject({ tasks: ["Task t1"], correctionCount: 1, attachmentCount: 1, cause: "plan", criteriaFacts: [{ id: "c1", state: "passed" }] });
    expect(lean.summary!.length).toBeLessThanOrEqual(PROJECT_LIMITS.shortText);
    expect(lean).not.toHaveProperty("attachments");
    expect(lean).not.toHaveProperty("corrections");
  });
});
