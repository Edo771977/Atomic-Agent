import { describe, expect, it, vi } from "vitest";

import { parseTeamMember, type TeamMember } from "../../llm/run-mode/fusion-team.js";
import {
  applyProjectDecision,
  applyProjectUpdate,
  gateVersion,
  type AssignmentRow,
  type ProjectState,
  type ProjectUpdate,
} from "../../session/session-project.js";
import { createEmptySessionState, type SessionState } from "../../session/session-state.js";
import type { ProjectPlanContext } from "../../tools/fusion/project-tools.js";
import { createRuntimeProject, nextMilestoneOf, type LiveProjectInputs, type ProjectGateEvent } from "./runtime-project.js";

const NOW = 1_700_000_000_000;
const m = (ref: string): TeamMember => parseTeamMember(ref)!;

function row(taskId: string, milestoneId: string, extra: Partial<AssignmentRow> = {}): AssignmentRow {
  return {
    taskId, title: `Task ${taskId}`, milestoneId, worker: "local:model-a", reviewer: "cloud:model-r",
    reason: "preset", basis: "preset", samples: 0, estCostUsd: 0.5, estMs: 1000, ...extra,
  };
}

const brief: ProjectUpdate = {
  kind: "brief",
  brief: { what: "A game", users: "Kids", how: "HTML", successCriteria: ["Runs"] },
  draftedAfterUntrusted: false,
};
const plan: ProjectUpdate = {
  kind: "plan",
  milestones: [{ id: "m1", title: "Base", kind: "base" }, { id: "m2", title: "UI", kind: "ui" }],
  rows: [row("t1", "m1"), row("t2", "m2", { estCostUsd: 3 })],
  detail: "compact",
};

const up = (p: ProjectState | undefined, u: ProjectUpdate): ProjectState => {
  const r = applyProjectUpdate(p, u, NOW);
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
};
const approved = (p: ProjectState): ProjectState => {
  const r = applyProjectDecision(p, { gate: p.gate, version: gateVersion(p)!, verdict: "approve" }, { now: NOW });
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
};

function planContext(): ProjectPlanContext {
  return {
    workers: [m("local:model-a"), m("cloud:model-b")],
    reviewers: [m("cloud:model-r"), m("cloud:model-b")],
    defaultWorker: m("local:model-a"),
    reviewerFor: () => m("cloud:model-r"),
    reviewOn: true,
    records: [],
    pricing: (member) => (member.providerId === "cloud" ? { input: 0.000001, output: 0.000002 } : undefined),
    tokensPerSecond: () => null,
    minSamples: 3,
    days: 30,
    now: NOW,
  };
}

function harness(options: { busy?: boolean; dailyRemainingUsd?: number | null; project?: ProjectState; status?: SessionState["status"] } = {}) {
  let stored: SessionState | null = {
    ...createEmptySessionState({ id: "s1", workingDir: "/w" }),
    ...(options.status === undefined ? {} : { status: options.status }),
    ...(options.project === undefined ? {} : { project: options.project }),
  };
  const events: Array<{ sessionId: string; event: ProjectGateEvent }> = [];
  const inputs: LiveProjectInputs = {
    plan: planContext(),
    constraints: {
      isLocal: (ref) => ref.startsWith("local:"),
      ...(options.dailyRemainingUsd === undefined ? {} : { dailyRemainingUsd: options.dailyRemainingUsd }),
    },
    strength: (member) => (member.model === "model-b" ? "best" : null),
    isLocal: (member) => member.providerId === "local",
  };
  const save = vi.fn((s: SessionState) => { stored = s; });
  const runtime = createRuntimeProject({
    loadSession: (id) => (id === "s1" ? stored : null),
    saveSession: save,
    isBusy: () => options.busy === true,
    liveInputs: () => inputs,
    emit: (sessionId, event) => events.push({ sessionId, event }),
    now: () => NOW + 7,
  });
  return { runtime, events, save, stored: () => stored };
}

describe("runtime.projectState / projectDecision (issue #39)", () => {
  it("projectState builds the gate view with live estimates and selectable members", () => {
    const { runtime } = harness({ project: up(approved(up(undefined, brief)), plan) });
    const view = runtime.projectState("s1")!;
    expect(view).toMatchObject({ schema: 1, sessionId: "s1", gate: { kind: "plan" }, version: 1 });
    expect(view.allowedVerdicts).toEqual(["approve", "edit", "cheaper", "quality", "cancel"]);
    expect(view.plan!.rows[0]!.selectableWorkers).toEqual(["local:model-a", "cloud:model-b"]);
    expect(view.plan!.rows[0]!.selectableReviewers).toEqual(["cloud:model-r", "cloud:model-b"]);
    expect(view.milestones.map((x) => x.estCostUsd)).toEqual([0.5, 3]);
    expect(runtime.projectState("missing")).toBeNull();
    expect(harness().runtime.projectState("s1")).toBeNull();
  });

  it("approves between turns, persists the session and emits project_gate", () => {
    const h = harness({ project: up(undefined, brief) });
    const result = h.runtime.projectDecision("s1", { gate: { kind: "brief" }, version: 1, verdict: "approve" });
    expect(result.ok).toBe(true);
    expect(h.stored()!.project!.brief).toMatchObject({ status: "approved", approvedAt: NOW + 7 });
    expect(h.events).toHaveLength(1);
    expect(h.events[0]!.event).toMatchObject({ type: "project_gate", view: { gate: { kind: "none" } } });
  });

  it("refuses while a turn runs, for an unknown session, and on a stale version (nothing saved or emitted)", () => {
    const busy = harness({ busy: true, project: up(undefined, brief) });
    expect(busy.runtime.projectDecision("s1", { gate: { kind: "brief" }, version: 1, verdict: "approve" }))
      .toMatchObject({ ok: false, error: { code: "turn-running" } });
    // Issue #74: a turn another process runs on the state dir counts too (stored status).
    const elsewhere = harness({ status: "running", project: up(undefined, brief) });
    expect(elsewhere.runtime.projectDecision("s1", { gate: { kind: "brief" }, version: 1, verdict: "approve" }))
      .toMatchObject({ ok: false, error: { code: "turn-running" } });
    expect(elsewhere.save).not.toHaveBeenCalled();
    const h = harness({ project: up(undefined, brief) });
    expect(h.runtime.projectDecision("nope", { gate: { kind: "brief" }, version: 1, verdict: "approve" }))
      .toMatchObject({ ok: false, error: { code: "no-session" } });
    expect(h.runtime.projectDecision("s1", { gate: { kind: "brief" }, version: 9, verdict: "approve" }))
      .toMatchObject({ ok: false, error: { code: "stale-version" } });
    expect(h.save).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it("the daily limit refuses approval only when the next milestone does not fit", () => {
    const drafted = up(approved(up(undefined, brief)), plan);
    // m1 costs 0.5, the plan 3.5: 1 left today is enough to start.
    const fits = harness({ project: drafted, dailyRemainingUsd: 1 });
    const view = fits.runtime.projectState("s1")!;
    expect(view.violations).toEqual([expect.objectContaining({ kind: "daily-limit", severity: "warn" })]);
    expect(fits.runtime.projectDecision("s1", { gate: { kind: "plan" }, version: 1, verdict: "approve" }).ok).toBe(true);
    const tight = harness({ project: drafted, dailyRemainingUsd: 0.25 });
    expect(tight.runtime.projectDecision("s1", { gate: { kind: "plan" }, version: 1, verdict: "approve" }))
      .toMatchObject({ ok: false, error: { code: "over-cap" } });
  });

  it("a milestone result is decided over the daily limit; the next milestone waits at a plan gate (issue #74)", () => {
    const running = approved(up(approved(up(undefined, brief)), plan));
    const reported = up(up(running, { kind: "milestone_run", id: "m1", runId: "r1" }), { kind: "milestone", id: "m1", state: "done", summary: "ok" });
    // m2 costs 3; 1 left today.
    const h = harness({ project: reported, dailyRemainingUsd: 1 });
    const r = h.runtime.projectDecision("s1", { gate: reported.gate, version: gateVersion(reported)!, verdict: "approve" });
    expect(r).toMatchObject({ ok: true, project: { milestones: [{ state: "reviewed" }, { state: "planned" }], gate: { kind: "plan" } } });
    if (!r.ok) throw new Error("x");
    expect(r.view.allowedVerdicts).toEqual(expect.arrayContaining(["cheaper", "quality", "edit"]));
    expect(r.view.violations).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "daily-limit", severity: "hard" })]));
  });

  it("cheaper, quality and a row edit are re-estimated from the live context", () => {
    const h = harness({ project: up(approved(up(undefined, brief)), plan) });
    const edited = h.runtime.projectDecision("s1", { gate: { kind: "plan" }, version: 1, verdict: "edit", edits: { rows: [{ taskId: "t1", worker: "cloud:model-b" }] } });
    if (!edited.ok) throw new Error(edited.error.message);
    const t1 = edited.project.plan!.rows[0]!;
    expect(t1).toMatchObject({ worker: "cloud:model-b", basis: "preset" });
    expect(t1.reason).toMatch(/edited by the person/);
    expect(t1.estCostUsd).not.toBeNull();
    const quality = h.runtime.projectDecision("s1", { gate: { kind: "plan" }, version: 2, verdict: "quality" });
    if (!quality.ok) throw new Error(quality.error.message);
    expect(quality.project.plan!.rows.map((r) => r.worker)).toEqual(["cloud:model-b", "cloud:model-b"]);
    expect(h.events.map((e) => e.event.view.version)).toEqual([2, 3]);
  });

  it("a milestone correction goes back to approved", () => {
    const running = approved(up(approved(up(undefined, brief)), plan));
    const reported = up(up(running, { kind: "milestone_run", id: "m1", runId: "r1" }), { kind: "milestone", id: "m1", state: "done", summary: "ok" });
    const h = harness({ project: reported });
    const r = h.runtime.projectDecision("s1", { gate: reported.gate, version: gateVersion(reported)!, verdict: "edit", edits: { note: "the score does not reset" } });
    expect(r).toMatchObject({ ok: true, project: { milestones: [{ state: "approved", corrections: [{ note: "the score does not reset" }] }, { state: "planned" }] } });
  });

  it("noteTurnEnd emits only when the turn moved the gate", () => {
    const before = up(undefined, brief);
    const h = harness({ project: before });
    h.runtime.noteTurnEnd("s1", before, before);
    expect(h.events).toEqual([]);
    h.runtime.noteTurnEnd("s1", undefined, before);
    expect(h.events).toHaveLength(1);
    h.runtime.noteTurnEnd("s1", before, undefined);
    expect(h.events).toHaveLength(1);
  });

  it("nextMilestoneOf: the first not finished, or the failed one at its gate", () => {
    const running = approved(up(approved(up(undefined, brief)), plan));
    expect(nextMilestoneOf(running)).toBe("m1");
    const done = up(up(running, { kind: "milestone_run", id: "m1", runId: "r1" }), { kind: "milestone", id: "m1", state: "done", summary: "ok" });
    expect(nextMilestoneOf(done)).toBe("m2");
    const failed = up(running, { kind: "milestone", id: "m1", state: "failed", summary: "no" });
    expect(nextMilestoneOf(failed)).toBe("m1");
  });
});
