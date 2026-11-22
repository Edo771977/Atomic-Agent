import * as signing from "../../session/receipt-signing.js";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectCardLines } from "../../tui/project/project-card-lines.js";
import { reduceProjectCard } from "../../tui/project/project-card-state.js";
import { projectCommand } from "../../cli/projects-command.js";
import { gateContentHash, projectFolderKey, stateDirProjectRecords } from "../../session/project-decisions.js";
import { appendProjectReceipt, createProjectReceiptWriter, verifyProjectReceipts, type ProjectReceiptWriter } from "../../session/project-receipts.js";
import { createSessionProjectStore, type SessionProjectStore } from "../../session/session-project-store.js";
import { receiptHash, type Receipt } from "../../session/receipt-signing.js";
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

function harness(options: { receiptStateDir?: string; busy?: boolean; dailyRemainingUsd?: number | null; project?: ProjectState; status?: SessionState["status"]; ownerAlive?: boolean; folder?: string; incognito?: SessionState["incognito"]; writeProjectReceipt?: ProjectReceiptWriter; session?: SessionState; projectStore?: SessionProjectStore; warnReceipt?: (message: string) => void } = {}) {
  let stored: SessionState | null = options.session ?? {
    ...createEmptySessionState({ id: "s1", workingDir: options.folder ?? "/w", ...(options.incognito ? { incognito: options.incognito } : {}) }),
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
    ...(options.receiptStateDir === undefined ? {} : { receiptStateDir: options.receiptStateDir }),
    saveSession: save,
    ...(options.projectStore ? { projectStore: options.projectStore } : {}),
    ...(options.warnReceipt ? { warnReceipt: options.warnReceipt } : {}),
    ...(options.writeProjectReceipt ? { writeProjectReceipt: options.writeProjectReceipt } : {}),
    isBusy: () => options.busy === true,
    liveTurnElsewhere: () => options.ownerAlive !== false,
    liveInputs: () => inputs,
    emit: (sessionId, event) => events.push({ sessionId, event }),
    now: () => NOW + 7,
  });
  return { runtime, events, save, stored: () => stored };
}

describe("runtime.projectState / projectDecision (issue #39)", () => {
  it("summarizes only the displayed milestone's evidence using public keys, and skips incognito", () => {
    const dir = mkdtempSync(join(tmpdir(), "milestone-receipts-"));
    try {
      const running = up(approved(up(approved(up(undefined, brief)), plan)), { kind: "milestone_run", id: "m1", runId: "r1" });
      const project = up(running, { kind: "milestone", id: "m1", state: "done", summary: "Finished" });
      const session = createEmptySessionState({ id: "s1", workingDir: dir });
      session.project = project;
      session.projectRef = { folder: dir, id: "project-one", revision: 1, decisionSeq: 1 };
      let pem: string | null = null;
      const keychain = {
        read: vi.fn(() => ({ ok: true as const, value: pem })),
        write: vi.fn((_key: string, value: string) => { pem = value; return true; }),
      };
      const evidence = { projectId: "project-one", milestoneId: "m1" };
      appendProjectReceipt(dir, dir, "artifact-manifest", { ...evidence, runId: "r1", result: "before" }, keychain);
      appendProjectReceipt(dir, dir, "check-run-record", { ...evidence, runId: "r1" }, { read: () => ({ ok: false }), write: () => false });
      appendProjectReceipt(dir, dir, "milestone-report", { ...evidence, version: gateVersion(project) }, keychain);
      appendProjectReceipt(dir, dir, "gate-verdict", evidence, keychain);
      appendProjectReceipt(dir, dir, "milestone-report", { ...evidence, milestoneId: "m2" }, keychain);
      appendProjectReceipt(dir, dir, "check-run-record", { ...evidence, projectId: "project-two" }, keychain);
      appendProjectReceipt(dir, dir, "artifact-manifest", { milestoneId: "m1" }, keychain);
      keychain.read.mockClear();
      keychain.write.mockClear();

      const { runtime } = harness({ session, receiptStateDir: dir });
      const summary = () => runtime.projectState("s1")?.milestones.find(m => m.id === "m1")?.evidenceReceipts;
      expect(summary()).toEqual({ valid: 2, unsigned: 1, problems: 0 });
      const card = reduceProjectCard(null, { type: "project_card_shown", sessionId: "s1", view: runtime.projectState("s1")! })!;
      expect(projectCardLines(card, 90).flatMap(line => line.segments).map(segment => segment.text).join("\n"))
        .toContain("1 unsigned (keychain signing key unavailable)");
      const archive = join(dir, "receipts", projectFolderKey(dir), "receipts.ndjson");
      writeFileSync(archive, readFileSync(archive, "utf8").replace('"before"', '"Before"'));
      expect(summary()).toEqual({ valid: 1, unsigned: 1, problems: 1 });
      expect(runtime.projectState("s1")?.milestones.find(m => m.id === "m2")?.evidenceReceipts).toBeUndefined();
      session.incognito = { owner: "test", since: NOW };
      expect(summary()).toBeUndefined();
      expect(keychain.read).not.toHaveBeenCalled();
      expect(keychain.write).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("verifies appended receipts once and skips verification for views that do not show evidence", () => {
    const folder = mkdtempSync(join(tmpdir(), "cached-receipts-"));
    const verify = vi.spyOn(signing, "verifyReceipt");
    try {
      const active = up(approved(up(approved(up(undefined, brief)), plan)), { kind: "milestone_run", id: "m1", runId: "r1" });
      const project = up(active, { kind: "milestone", id: "m1", state: "done", summary: "Finished" });
      const session = createEmptySessionState({ id: "s1", workingDir: folder });
      session.project = project;
      session.projectRef = { folder, id: "project-one", revision: 1, decisionSeq: 1 };
      const { runtime } = harness({ session, receiptStateDir: folder });
      const append = (name: string) => appendProjectReceipt(folder, folder, "artifact-manifest", {
        projectId: "project-one", milestoneId: "m1", runId: "r1", name,
      }, { read: () => ({ ok: false }), write: () => false });
      append("one");
      JSON.stringify(runtime.projectState("s1"));
      expect(verify).not.toHaveBeenCalled();
      const read = () => runtime.projectState("s1")?.milestones[0]?.evidenceReceipts;
      expect(read()?.unsigned).toBe(1);
      expect(read()?.unsigned).toBe(1);
      expect(verify).toHaveBeenCalledTimes(1);
      append("two");
      expect(read()?.unsigned).toBe(2);
      expect(verify).toHaveBeenCalledTimes(2);
    } finally {
      verify.mockRestore();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it.each(["corrected", "superseded"] as const)("excludes replaced evidence from a %s milestone", scenario => {
    const folder = mkdtempSync(join(tmpdir(), "revision-receipts-"));
    try {
      let project = approved(up(approved(up(undefined, brief)), plan));
      project = up(project, { kind: "milestone_run", id: "m1", runId: "old" });
      project = up(project, { kind: "milestone", id: "m1", state: "done", summary: "First" });
      const previousVersion = gateVersion(project);
      const old = project.milestones[0]!;
      project = {
        ...project,
        plan: { ...project.plan!, version: previousVersion! + 1 },
        milestones: project.milestones.map(m => m.id !== "m1" ? m : {
          ...m, runIds: scenario === "corrected" ? ["old", "new"] : ["new"],
          ...(scenario === "corrected" ? { corrections: [{ note: "Retry", at: NOW + 1 }], evidenceSince: NOW + 1 } : {}),
        }),
      };
      const session = createEmptySessionState({ id: "s1", workingDir: folder });
      session.project = project;
      session.projectRef = { folder, id: "project-one", revision: 1, decisionSeq: 1 };
      const keychain = { read: () => ({ ok: false as const }), write: () => false };
      const payload = { projectId: "project-one", milestoneId: old.id };
      vi.useFakeTimers({ now: NOW });
      appendProjectReceipt(folder, folder, "artifact-manifest", { ...payload, runId: "old" }, keychain);
      appendProjectReceipt(folder, folder, "milestone-report", { ...payload, version: previousVersion }, keychain);
      vi.setSystemTime(NOW + 2);
      appendProjectReceipt(folder, folder, "artifact-manifest", { ...payload, runId: "new" }, keychain);
      appendProjectReceipt(folder, folder, "check-run-record", payload, keychain);
      appendProjectReceipt(folder, folder, "milestone-report", { ...payload, version: gateVersion(project) }, keychain);
      const { runtime } = harness({ session, receiptStateDir: folder });
      expect(runtime.projectState("s1")?.milestones[0]?.evidenceReceipts).toMatchObject({ unsigned: 2, problems: 0 });
    } finally {
      vi.useRealTimers();
      rmSync(folder, { recursive: true, force: true });
    }
  });

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
    // A status a crashed process left behind does not hold the gate shut.
    const stale = harness({ status: "running", ownerAlive: false, project: up(undefined, brief) });
    expect(stale.runtime.projectDecision("s1", { gate: { kind: "brief" }, version: 1, verdict: "approve" }).ok).toBe(true);
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

  it("nextMilestoneOf agrees with what an approval starts: a reset milestone ahead of a running one waits (issue #80)", () => {
    let p = approved(up(approved(up(undefined, brief)), plan));
    p = up(p, { kind: "milestone_run", id: "m1", runId: "r1" });
    p = approved(up(p, { kind: "milestone", id: "m1", state: "done", summary: "ok" }));
    p = up(p, { kind: "milestone_run", id: "m2", runId: "r2" });
    // m1's work changes while m2 runs: m1 is reset ahead of the running m2.
    p = up(p, { ...plan, rows: [row("t1", "m1", { title: "Rewrite the storage" }), row("t2", "m2", { estCostUsd: 3 })] } as ProjectUpdate);
    expect(p.milestones.map((m) => m.state)).toEqual(["planned", "in_progress"]);
    expect(nextMilestoneOf(p)).toBe("m2");
    // The daily limit is held against m2's cost, the run that goes on.
    const approvedPlan = approved(p);
    expect(approvedPlan.milestones.map((m) => m.state)).toEqual(["planned", "in_progress"]);
    expect(nextMilestoneOf(approvedPlan)).toBe("m2");
    // m2's done result at its gate: m1 is what its approval starts.
    const reported = up(approvedPlan, { kind: "milestone", id: "m2", state: "done", summary: "ok" });
    expect(nextMilestoneOf(reported)).toBe("m1");
    expect(approved(reported).milestones.map((m) => m.state)).toEqual(["approved", "reviewed"]);
  });
});

describe("runtime.projectDecision on the folder store (issue #109)", () => {
  it("a second chat deciding the gate another chat decided gets already-decided", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createSessionProjectStore } = await import("../../session/session-project-store.js");
    const { stateDirProjectRecords } = await import("../../session/project-decisions.js");
    const folder = mkdtempSync(join(tmpdir(), "aa-rp-"));
    const stateDir = mkdtempSync(join(tmpdir(), "aa-rp-state-"));
    try {
      const projectStore = createSessionProjectStore({ stateDir, records: stateDirProjectRecords(stateDir) });
      const created = projectStore.commit(createEmptySessionState({ id: "a", workingDir: folder }), up(undefined, brief));
      if (!created.ok) throw new Error(created.problem.message);
      const sessions = new Map<string, SessionState>([
        ["a", created.session],
        ["b", projectStore.prepareTurn(createEmptySessionState({ id: "b", workingDir: folder }), true)],
      ]);
      const inputs: LiveProjectInputs = { plan: planContext(), constraints: { isLocal: () => true }, strength: () => null, isLocal: () => true };
      const runtime = createRuntimeProject({
        loadSession: (id) => {
          const s = sessions.get(id);
          return s === undefined ? null : projectStore.load(s);
        },
        saveSession: (s) => { sessions.set(s.id, s); },
        projectStore,
        isBusy: () => false,
        liveInputs: () => inputs,
        emit: () => {},
        now: () => NOW,
      });
      const decision = { gate: { kind: "brief" as const }, version: 1, verdict: "approve" as const };
      expect(runtime.projectDecision("a", decision).ok).toBe(true);
      expect(runtime.projectDecision("b", decision)).toMatchObject({ ok: false, error: { code: "already-decided", message: expect.stringMatching(/already decided/) } });
      expect(runtime.projectState("b")?.brief?.status).toBe("approved");
    } finally {
      rmSync(folder, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe("runtime.projectBacklogDecision (issue #111)", () => {
  const withItem = (): ProjectState =>
    up(up(approved(up(undefined, brief)), plan), { kind: "backlog_add", item: { id: "b1", title: "Export PDF", source: "director", condition: "when the report exists" } });

  it("is the person's call between turns: persisted, no gate moved, project_gate emitted", () => {
    const h = harness({ project: withItem() });
    const before = h.stored()!.project!;
    const result = h.runtime.projectBacklogDecision("s1", { id: "b1", state: "promoted" });
    expect(result.ok).toBe(true);
    expect(h.stored()?.project?.backlogStates).toEqual({ b1: "promoted" });
    expect(h.stored()?.project?.gate).toEqual(before.gate);
    expect(gateVersion(h.stored()?.project)).toBe(gateVersion(before));
    expect(h.events.at(-1)?.event.type).toBe("project_gate");
  });

  it("is refused while a turn runs, for an unknown item, and without a session", () => {
    expect(harness({ project: withItem(), busy: true }).runtime.projectBacklogDecision("s1", { id: "b1", state: "dropped" })).toMatchObject({ ok: false, error: { code: "turn-running" } });
    expect(harness({ project: withItem() }).runtime.projectBacklogDecision("s1", { id: "b9", state: "dropped" })).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(harness({ project: withItem() }).runtime.projectBacklogDecision("nope", { id: "b1", state: "dropped" })).toMatchObject({ ok: false, error: { code: "no-session" } });
  });

  it("an automatic approval never decides a backlog item", () => {
    // The gate decision path carries no backlog call: approving every gate leaves the item open.
    let p = withItem();
    for (let i = 0; i < 3 && p.gate.kind !== "none"; i++) p = approved(p);
    expect(p.backlogStates).toBeUndefined();
  });
});

describe("gate verdict receipts", () => {
  const decision = { gate: { kind: "brief" as const }, version: 1, verdict: "approve" as const };

  it("signs saved brief and plan decisions and detects changes to their archive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-receipts-"));
    const folder = mkdtempSync(join(tmpdir(), "gate-project-"));
    try {
      let pem: string | null = null;
      const writeProjectReceipt = createProjectReceiptWriter(dir, {
        read: () => ({ ok: true, value: pem }),
        write: (_key, value) => { pem = value; return true; },
      }, vi.fn());
      const projectStore = createSessionProjectStore({ stateDir: dir, records: stateDirProjectRecords(dir) });
      const created = projectStore.commit(createEmptySessionState({ id: "s1", workingDir: folder }), up(undefined, brief));
      if (!created.ok) throw new Error(created.problem.message);
      const draft = created.session.project!;
      const h = harness({ session: created.session, projectStore, writeProjectReceipt });
      expect(h.runtime.projectDecision("s1", { ...decision, version: 2 }).ok).toBe(false);
      const accepted = h.runtime.projectDecision("s1", decision);
      if (!accepted.ok) throw new Error(accepted.error.message);
      expect(h.runtime.projectDecision("s1", decision).ok).toBe(false);
      const submitted = projectStore.commit(h.stored()!, up(accepted.project, plan));
      if (!submitted.ok) throw new Error(submitted.problem.message);
      const planDraft = submitted.session.project!;
      const planned = harness({ session: submitted.session, projectStore, writeProjectReceipt });
      expect(planned.runtime.projectDecision("s1", { ...decision, gate: { kind: "plan" } }, "auto-approve").ok).toBe(true);
      const path = join(dir, "receipts", projectFolderKey(folder), "receipts.ndjson");
      const original = readFileSync(path, "utf8");
      const rows = original.trim().split("\n").map(line => JSON.parse(line) as Receipt);
      expect(rows).toMatchObject([
        { kind: "gate-verdict", payload: { gate: "brief", version: 1, verdict: "approve", actor: "person", contentHash: gateContentHash(draft, decision.gate) } },
        { kind: "gate-verdict", payload: { gate: "plan", version: 1, verdict: "approve", actor: "auto-approve", contentHash: gateContentHash(planDraft, { kind: "plan" }) } },
      ]);
      const stdout = vi.fn();
      expect(await projectCommand(["verify", folder], { stateDir: () => dir, stdout })).toBe(0);
      expect(stdout.mock.calls.flat().join("")).toContain("gate-verdict: 2 valid");
      expect(stdout.mock.calls.flat().join("")).toContain(`Receipt 1: valid (project ${created.session.projectRef?.id})`);
      stdout.mockClear();
      expect(await projectCommand(["verify", "--json", folder], { stateDir: () => dir, stdout })).toBe(0);
      expect(JSON.parse(stdout.mock.calls.flat().join(""))).toEqual([
        { kind: "gate-verdict", status: "valid", projectId: created.session.projectRef?.id },
        { kind: "gate-verdict", status: "valid", projectId: created.session.projectRef?.id },
      ]);

      const secret = (pem as string | null)?.trim().split("\n")[1];
      expect(secret).toBeTruthy();
      for (const root of [dir, folder]) {
        for (const file of readdirSync(root, { recursive: true, withFileTypes: true })) {
          if (file.isFile()) expect(readFileSync(join(file.parentPath, file.name), "utf8")).not.toContain(secret);
        }
      }
      writeFileSync(path, original.replace('"person"', '"Person"').replaceAll("\n", "\r\n"));
      expect(verifyProjectReceipts(dir, folder)).toEqual(["hash-mismatch", "valid"]);
      stdout.mockClear();
      expect(await projectCommand(["verify", folder], { stateDir: () => dir, stdout })).toBe(1);
      expect(stdout.mock.calls.flat().join("")).toContain("gate-verdict: 1 valid, 1 hash-mismatch");
      const edited = JSON.parse(original.replace('"person"', '"Person"').split("\n")[0]!) as Receipt;
      edited.payloadHash = receiptHash(edited.payload);
      writeFileSync(path, JSON.stringify(edited) + "\n");
      expect(verifyProjectReceipts(dir, folder)).toEqual(["bad-signature"]);
      stdout.mockClear();
      expect(await projectCommand(["verify", folder], { stateDir: () => dir, stdout })).toBe(1);
      expect(stdout.mock.calls.flat().join("")).toContain("1 bad-signature");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("does not archive a different embedded project's decision in a folder already holding a project", () => {
    const folder = mkdtempSync(join(tmpdir(), "receipt-project-collision-"));
    try {
      const projectStore = createSessionProjectStore({ stateDir: folder, records: stateDirProjectRecords(folder) });
      const first = projectStore.commit(createEmptySessionState({ id: "first", workingDir: folder }), up(undefined, brief));
      if (!first.ok) throw new Error(first.problem.message);
      const other = up(undefined, { kind: "brief", draftedAfterUntrusted: false, brief: { what: "Other", users: "Kids", how: "HTML", successCriteria: ["Runs"] } });
      const writeProjectReceipt = vi.fn();
      const h = harness({ project: other, folder, projectStore, writeProjectReceipt });
      expect(h.runtime.projectDecision("s1", decision).ok).toBe(true);
      expect(h.stored()?.project?.brief).toMatchObject({ what: "Other", status: "approved" });
      expect(h.stored()?.projectRef).toBeUndefined();
      expect(writeProjectReceipt).not.toHaveBeenCalled();
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("keeps the saved decision when the keychain is unavailable, and skips incognito and failed saves", () => {
    const folder = mkdtempSync(join(tmpdir(), "unsigned-gates-"));
    try {
      const warning = vi.fn();
      const writeProjectReceipt = createProjectReceiptWriter(folder, {
        read: () => ({ ok: false }), write: () => false,
      }, warning);
      const project = up(undefined, brief);
      const privateChat = harness({ project, folder, writeProjectReceipt, incognito: { owner: "test", since: NOW } });
      expect(privateChat.runtime.projectDecision("s1", decision).ok).toBe(true);
      expect(verifyProjectReceipts(folder, folder)).toEqual([]);
      const h = harness({ project, folder, writeProjectReceipt });
      h.save.mockImplementationOnce(() => { throw new Error("save failed"); });
      expect(() => h.runtime.projectDecision("s1", decision)).toThrow("save failed");
      expect(verifyProjectReceipts(folder, folder)).toEqual([]);
      expect(h.runtime.projectDecision("s1", decision).ok).toBe(true);
      expect(h.stored()?.project?.brief?.status).toBe("approved");
      expect(verifyProjectReceipts(folder, folder)).toEqual(["unsigned"]);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("unsigned"));
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it.each(["edit", "cheaper", "quality"] as const)("fingerprints the result of %s as well as the input", verdict => {
    const draft = up(approved(up(undefined, brief)), plan);
    const writeProjectReceipt = vi.fn();
    const h = harness({ project: draft, writeProjectReceipt });
    const gate = { kind: "plan" as const };
    const result = h.runtime.projectDecision("s1", {
      gate, version: 1, verdict,
      ...(verdict === "edit" ? { edits: { rows: [{ taskId: "t1", worker: "cloud:model-b" }] } } : {}),
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(writeProjectReceipt).toHaveBeenCalledWith(expect.any(String), "gate-verdict", expect.objectContaining({
      contentHash: gateContentHash(draft, gate), resultHash: gateContentHash(result.project, gate),
    }));
    expect(gateContentHash(result.project, gate)).not.toBe(gateContentHash(draft, gate));
  });

  it("archives a committed folder decision even if the session save fails", () => {
    const folder = mkdtempSync(join(tmpdir(), "receipt-session-save-fails-"));
    try {
      const projectStore = createSessionProjectStore({ stateDir: folder, records: stateDirProjectRecords(folder) });
      const created = projectStore.commit(createEmptySessionState({ id: "s1", workingDir: folder }), up(undefined, brief));
      if (!created.ok) throw new Error(created.problem.message);
      const statusAtWrite: Array<string | undefined> = [];
      const writeProjectReceipt = vi.fn(() => {
        statusAtWrite.push(projectStore.load(created.session).project?.brief?.status);
      });
      const h = harness({ session: created.session, projectStore, writeProjectReceipt });
      h.save.mockImplementationOnce(() => { throw new Error("session save failed"); });
      expect(() => h.runtime.projectDecision("s1", decision)).toThrow("session save failed");
      expect(projectStore.load(created.session).project?.brief?.status).toBe("approved");
      expect(writeProjectReceipt).toHaveBeenCalledExactlyOnceWith(folder, "gate-verdict", expect.objectContaining({ projectId: created.session.projectRef?.id }));
      expect(statusAtWrite).toEqual(["approved"]);
      expect(h.events).toHaveLength(0);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("logs write failures without leaking errors or undoing the decision", () => {
    const warnReceipt = vi.fn();
    const h = harness({
      project: up(undefined, brief),
      writeProjectReceipt: () => { throw new Error("private keychain detail"); },
      warnReceipt,
    });
    expect(h.runtime.projectDecision("s1", decision).ok).toBe(true);
    expect(h.stored()?.project?.brief?.status).toBe("approved");
    expect(warnReceipt).toHaveBeenCalledWith("Could not save an evidence receipt. The project archive may be incomplete.");
  });

  it("records the person's saved approval-over-review note", () => {
    const inProgress = up(approved(up(approved(up(undefined, brief)), plan)), { kind: "milestone_run", id: "m1", runId: "r" });
    const report = up(inProgress, { kind: "milestone", id: "m1", state: "failed", summary: "Blocked", reviewBlocks: [{ taskId: "t1", reason: "open" }] });
    const writeProjectReceipt = vi.fn();
    const h = harness({ project: report, writeProjectReceipt });
    expect(h.runtime.projectDecision("s1", { gate: report.gate, version: gateVersion(report)!, verdict: "approveOverReview", edits: { note: "Accepted risk" } }).ok).toBe(true);
    expect(writeProjectReceipt).toHaveBeenCalledWith(expect.any(String), "gate-verdict", expect.objectContaining({ gate: "milestone", milestoneId: "m1", verdict: "approveOverReview", note: "Accepted risk" }));
  });
});
