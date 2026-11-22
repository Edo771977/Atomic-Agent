import { describe, expect, it, vi } from "vitest";

import { FIXTURE_SHOT_PATH, fixtureProjectGateView, withFixtureMilestoneEvidence } from "../session/project-gate-view-fixtures.js";
import type { ProjectGateView } from "../session/project-gate-view.js";
import { parseRunArgs } from "./run-agent.js";
import { editProjectDecisionStatuses, settleProjectGate } from "./run-project-gate.js";

function runtime(view: ProjectGateView | undefined, after?: ProjectGateView) {
  return {
    projectState: vi.fn(() => view ?? null),
    projectDecision: vi.fn(() =>
      after === undefined
        ? { ok: false as const, error: { code: "over-cap" as const, message: "over today's limit", violations: [] } }
        : { ok: true as const, project: { milestones: [], gate: { kind: "none" as const } }, view: after }),
  };
}

describe("run at a project gate", () => {
  it("stops with a readable summary, the session id and how to approve", async () => {
    const rt = runtime(fixtureProjectGateView({ kind: "plan" }));
    const step = await settleProjectGate(rt, "sess-1", "stop");
    expect(step.kind).toBe("stop");
    if (step.kind !== "stop") return;
    expect(step.text).toContain("The project plan waits for your approval (version 3).");
    expect(step.text).toContain("t1 Board and pieces [m1]: worker prov-a:model-a · review prov-b:model-b · $0.12 · ~1m30s · measured (6 runs)");
    expect(step.text).toContain("t2 Level screen [m2]: worker prov-c:model-c · review none · cost unknown · time unknown · preset");
    expect(step.text).toContain("Total: 2 tasks · $0.12 (+1 unpriced)");
    expect(step.text).toContain("Approving lets these tasks write in this chat's folder");
    expect(step.text).toContain("session: sess-1");
    expect(step.text).toContain("atomic-agent run --session sess-1 --approve 3");
    expect(rt.projectDecision).not.toHaveBeenCalled();
  });

  it("auto-approval refused by a plan check stops naming the plan, not a milestone review (issue #112)", async () => {
    const message = "The plan stays open: decision-coverage: fail: No plan task that will run cites active decisions: d2 (No new dependencies). Update the plan before approval.";
    const rt = {
      projectState: vi.fn(() => fixtureProjectGateView({ kind: "plan" })),
      projectDecision: vi.fn(() => ({ ok: false as const, error: { code: "review-open" as const, message, blocks: [{ taskId: "plan", reason: "decision-coverage: fail: …" }] } })),
    };
    const step = await settleProjectGate(rt, "sess-1", "approve");
    expect(step.kind).toBe("stop");
    if (step.kind !== "stop") return;
    expect(step.text).toContain(`A plan check still blocks the plan: this needs a person, so it is not approved automatically. ${message}`);
    expect(step.text).not.toContain("milestone");
    expect(step.text).toContain("atomic-agent run --session sess-1");
  });

  it("prints a local row as $0.00 (local), not unpriced (issue #54)", async () => {
    const base = fixtureProjectGateView({ kind: "plan" });
    const rows = base.plan!.rows.map((r) => r.taskId === "t2" ? { ...r, estCostUsd: 0, local: true as const } : r);
    const step = await settleProjectGate(runtime({ ...base, plan: { ...base.plan!, rows, totals: { ...base.plan!.totals, unknownCostRows: 0 } } }), "sess-1", "stop");
    if (step.kind !== "stop") throw new Error("expected a stop");
    expect(step.text).toContain("t2 Level screen [m2]: worker prov-c:model-c · review none · $0.00 (local) · time unknown · preset");
    expect(step.text).not.toContain("unpriced");
  });

  it("prints the view's hints (issue #54)", async () => {
    const view = fixtureProjectGateView({ kind: "plan" }, { hints: ["no reviewers configured: add llm.runMode.fusion.team.reviewers to have each task reviewed"] });
    const step = await settleProjectGate(runtime(view), "sess-1", "stop");
    if (step.kind !== "stop") throw new Error("expected a stop");
    expect(step.text).toContain("no reviewers configured: add llm.runMode.fusion.team.reviewers to have each task reviewed");
  });

  it("a milestone gate prints its criteria facts and pictures (issue #40)", async () => {
    const view = withFixtureMilestoneEvidence(fixtureProjectGateView({ kind: "milestone", id: "m1" }, { allowedVerdicts: ["approve", "edit", "cancel"] }));
    const step = await settleProjectGate(runtime(view), "s", "stop");
    expect(step.kind === "stop" && step.text).toContain("Criteria:\n    ✓ c1 passed: Runs in a browser");
    expect(step.kind === "stop" && step.text).toContain(`Picture: The board at start [c1] — ${FIXTURE_SHOT_PATH}`);
  });

  it("the printed plan warns when it was drafted after outside content", async () => {
    const base = fixtureProjectGateView({ kind: "plan" });
    const step = await settleProjectGate(runtime({ ...base, plan: { ...base.plan!, draftedAfterUntrusted: true } }), "s", "stop");
    expect(step.kind === "stop" && step.text).toMatch(/The plan was drafted after outside content/);
  });

  it("carries on when nothing waits", async () => {
    expect((await settleProjectGate(runtime(undefined), "s", "stop")).kind).toBe("open");
    expect((await settleProjectGate(runtime(fixtureProjectGateView({ kind: "none" })), "s", "approve")).kind).toBe("open");
  });

  it("approves the current gate at the version shown and returns the continuing message", async () => {
    const after = fixtureProjectGateView({ kind: "none" }, { expectation: { kind: "run_milestone", id: "m1" } });
    const rt = runtime(fixtureProjectGateView({ kind: "plan" }), after);
    const step = await settleProjectGate(rt, "s", { version: 3 });
    expect(rt.projectDecision).toHaveBeenCalledWith("s", { gate: { kind: "plan" }, version: 3, verdict: "approve" });
    expect(step).toEqual({
      kind: "approved",
      line: "approved the plan (version 3): 2 tasks, $0.12 (+1 unpriced), ~1m30s",
      message: 'I approved. Continue with milestone "Base".',
      project: { milestones: [], gate: { kind: "none" } },
    });
  });

  it("--approve <version> refuses a gate that changed since that version", async () => {
    const rt = runtime(fixtureProjectGateView({ kind: "plan" }), fixtureProjectGateView({ kind: "none" }));
    const step = await settleProjectGate(rt, "s", { version: 2 });
    expect(step.kind).toBe("failed");
    if (step.kind === "failed") {
      expect(step.text).toContain("not approved: the plan changed since version 2; current is 3");
      expect(step.text).toContain("The project plan waits for your approval (version 3).");
    }
    expect(rt.projectDecision).not.toHaveBeenCalled();
  });

  it("--auto-approve-project approves the current version", async () => {
    const rt = runtime(fixtureProjectGateView({ kind: "plan" }), fixtureProjectGateView({ kind: "none" }));
    expect((await settleProjectGate(rt, "s", "approve")).kind).toBe("approved");
    expect(rt.projectDecision).toHaveBeenCalledWith("s", { gate: { kind: "plan" }, version: 3, verdict: "approve" });
  });

  it("auto approval stops at a failed milestone: only a person decides a retry", async () => {
    const base = fixtureProjectGateView({ kind: "milestone", id: "m1" });
    const failed = { ...base, milestones: base.milestones.map((m) => (m.id === "m1" ? { ...m, state: "failed" as const } : m)) };
    const rt = runtime(failed, fixtureProjectGateView({ kind: "none" }));
    const step = await settleProjectGate(rt, "s", "approve");
    expect(step.kind).toBe("stop");
    if (step.kind === "stop") expect(step.text).toContain("needs a person");
    expect(rt.projectDecision).not.toHaveBeenCalled();
    // An explicit --approve <version> still decides it.
    expect((await settleProjectGate(rt, "s", { version: 3 })).kind).toBe("approved");
  });

  it("a refused approval (over a hard cap) fails with the reason and the summary", async () => {
    const step = await settleProjectGate(runtime(fixtureProjectGateView({ kind: "plan" })), "s", "approve");
    expect(step.kind).toBe("failed");
    if (step.kind === "failed") expect(step.text).toMatch(/over today's limit/);
  });

  it("a runtime without projects carries on", async () => {
    expect((await settleProjectGate({}, "s", "stop")).kind).toBe("open");
  });
});

describe("run flags for project gates", () => {
  it("parses decision edits with a continued session and rejects conflicting actions", () => {
    expect(parseRunArgs(["--session", "abc", "--defer-decision", "D1, d2", "--reactivate-decision", "d3"]))
      .toMatchObject({ decisionStatus: { d1: "deferred", d2: "deferred", d3: "active" } });
    expect(parseRunArgs(["--defer-decision", "d1"])).toEqual({ error: "decision status edits need --session <id>" });
    expect(parseRunArgs(["--session", "abc", "--defer-decision", "d1,"])).toMatchObject({ error: expect.stringContaining("--defer-decision") });
    expect(parseRunArgs(["--session", "abc", "--defer-decision", "d1", "--reactivate-decision", "d1"]))
      .toMatchObject({ error: expect.stringContaining("d1") });
    for (const flag of ["--auto-approve-project", "--approve"]) {
      expect(parseRunArgs(["--session", "abc", "--defer-decision", "d1", flag]))
        .toMatchObject({ error: expect.stringContaining(flag) });
    }
  });

  it("refuses status edits outside the plan gate or against an unknown brief decision", () => {
    const brief = runtime(fixtureProjectGateView({ kind: "brief" }));
    const plan = runtime(fixtureProjectGateView({ kind: "plan" }));
    expect(editProjectDecisionStatuses(brief, "s", { d1: "active" }))
      .toMatchObject({ kind: "failed", text: expect.stringContaining("only at the plan gate") });
    expect(editProjectDecisionStatuses(plan, "s", { d9: "deferred" }))
      .toMatchObject({ kind: "failed", text: expect.stringContaining("d9 is not a decision of the approved brief") });
    expect(brief.projectDecision).not.toHaveBeenCalled();
    expect(plan.projectDecision).not.toHaveBeenCalled();
  });

  it("parses --session, --approve and --auto-approve-project", () => {
    expect(parseRunArgs(["--session", "abc", "--approve", "3"])).toMatchObject({ session: "abc", approve: true, approveVersion: 3, autoApproveProject: false });
    expect(parseRunArgs(["--session", "abc", "--approve"])).toMatchObject({ approve: true, approveVersion: null });
    expect(parseRunArgs(["--approve", "--session", "abc"])).toMatchObject({ approve: true, approveVersion: null, session: "abc" });
    expect(parseRunArgs(["--auto-approve-project"])).toMatchObject({ autoApproveProject: true, session: null });
  });

  it("refuses --approve without --session", () => {
    expect(parseRunArgs(["--approve"])).toEqual({ error: "--approve needs --session <id>" });
    expect(parseRunArgs(["--session"])).toEqual({ error: "--session requires a value" });
  });

  it("--auto-approve-project stops at a gate whose content changed outside Atomic Agent (issue #109)", async () => {
    const rt = runtime(fixtureProjectGateView({ kind: "plan" }, { changedOutside: true }), fixtureProjectGateView({ kind: "none" }));
    const step = await settleProjectGate(rt, "sess-1", "approve");
    expect(step.kind).toBe("stop");
    if (step.kind === "stop") expect(step.text).toContain("changed outside Atomic Agent");
    expect(rt.projectDecision).not.toHaveBeenCalled();
    // The person's own --approve <version> still decides it.
    const own = await settleProjectGate(rt, "sess-1", { version: 3 });
    expect(own.kind).toBe("approved");
  });
});

describe("run at a plan the plan reviewer still fails (issue #118)", () => {
  it("auto-approval stops and says the person approves over the review, never overriding", async () => {
    const message = "The plan stays open: the plan reviewer's notes fail it: plan review: scope: fail: drops the level editor.";
    const rt = {
      projectState: vi.fn(() => fixtureProjectGateView({ kind: "plan" }, { allowedVerdicts: ["approve", "edit", "cheaper", "quality", "approveOverReview", "cancel"] })),
      projectDecision: vi.fn(() => ({ ok: false as const, error: { code: "review-open" as const, message, blocks: [{ taskId: "plan", reason: "plan review: scope: fail: drops the level editor." }] } })),
    };
    const step = await settleProjectGate(rt, "sess-1", "approve");
    expect(step.kind).toBe("stop");
    if (step.kind !== "stop") return;
    expect(step.text).toContain(`The plan reviewer's open notes still fail the plan: this needs a person, so it is not approved automatically. ${message}`);
    expect(rt.projectDecision).toHaveBeenCalledTimes(1);
    expect(rt.projectDecision).toHaveBeenCalledWith("sess-1", expect.objectContaining({ verdict: "approve" }));
  });
});

describe("run at a plan gate with promoted backlog items (issue #111 review)", () => {
  const backlog = { open: 0, seeds: [], promoted: [{ id: "b2", title: "PDF export" }], stale: [], items: [] };

  it("--auto-approve-project stops while an item the person promoted waits for a plan", async () => {
    const rt = runtime({ ...fixtureProjectGateView({ kind: "plan" }), backlog }, fixtureProjectGateView({ kind: "none" }));
    const step = await settleProjectGate(rt, "sess-1", "approve");
    expect(step.kind).toBe("stop");
    expect(step.kind === "stop" && step.text).toContain("The person promoted backlog items for this plan (b2 PDF export): a person checks the plan takes them in, so it is not approved automatically.");
    expect(rt.projectDecision).not.toHaveBeenCalled();
  });

  it("a person's --approve <version> still approves it (a warning, not a block)", async () => {
    const rt = runtime({ ...fixtureProjectGateView({ kind: "plan" }), backlog }, fixtureProjectGateView({ kind: "none" }));
    const step = await settleProjectGate(rt, "sess-1", { version: 3 });
    expect(step.kind).not.toBe("stop");
    expect(rt.projectDecision).toHaveBeenCalledTimes(1);
  });
});
