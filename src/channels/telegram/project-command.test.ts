import { describe, expect, it, vi } from "vitest";

import { FIXTURE_SHOT_PATH, fixtureProjectGateView, withFixtureMilestoneEvidence } from "../../session/project-gate-view-fixtures.js";
import type { ProjectGateView } from "../../session/project-gate-view.js";
import type { ProjectDecision } from "../../session/session-project.js";
import { projectGateNotice, runProjectCommand } from "./project-command.js";

function runtime(view: ProjectGateView | undefined, after?: ProjectGateView) {
  return {
    projectState: vi.fn(() => view ?? null),
    projectDecision: vi.fn((_id: string, _d: ProjectDecision) =>
      after === undefined
        ? { ok: false as const, error: { code: "over-cap" as const, message: "over today's limit", violations: [] } }
        : { ok: true as const, project: { milestones: [], gate: { kind: "none" as const } }, view: after }),
  };
}

const running = fixtureProjectGateView({ kind: "none" }, { expectation: { kind: "run_milestone", id: "m1" } });

describe("Telegram /plan (issue #39)", () => {
  it("bare /plan shows the open gate and the two text verdicts", async () => {
    const out = await runProjectCommand([], { runtime: runtime(fixtureProjectGateView({ kind: "plan" })), sessionId: "s", busy: false });
    expect(out.text).toContain("The project plan waits for your approval (version 3).");
    expect(out.text).toContain("/plan approve 3");
    expect(out.continueWith).toBeNull();
  });

  it("a milestone gate lists its criteria facts and pictures (issue #40)", async () => {
    const view = withFixtureMilestoneEvidence(fixtureProjectGateView({ kind: "milestone", id: "m1" }));
    const out = await runProjectCommand([], { runtime: runtime(view), sessionId: "s", busy: false });
    expect(out.text).toContain("  Criteria:\n    ✓ c1 passed: Runs in a browser\n    ? c2 unverified: Ten levels (no vision-capable reviewer)");
    expect(out.text).toContain(`  Picture: The board at start [c1] — ${FIXTURE_SHOT_PATH}`);
  });

  it("/plan approve needs the version shown: bare shows the gate and asks again, a stale one is refused", async () => {
    const rt = runtime(fixtureProjectGateView({ kind: "plan" }), running);
    const bare = await runProjectCommand(["approve"], { runtime: rt, sessionId: "s", busy: false });
    expect(bare.text).toContain("The project plan waits for your approval (version 3).");
    expect(bare.text).toContain("/plan approve 3");
    expect(bare.continueWith).toBeNull();
    const stale = await runProjectCommand(["approve", "2"], { runtime: rt, sessionId: "s", busy: false });
    expect(stale.text).toBe("Not approved: the plan changed since version 2; current is 3. Reply /plan to see it.");
    expect(rt.projectDecision).not.toHaveBeenCalled();
    expect((await runProjectCommand(["approve", "x"], { runtime: rt, sessionId: "s", busy: false })).text).toMatch(/Usage: \/plan/);
  });

  it("/plan approve <version> approves at the version shown and hands back the continuing message", async () => {
    const rt = runtime(fixtureProjectGateView({ kind: "plan" }), running);
    const out = await runProjectCommand(["approve", "3"], { runtime: rt, sessionId: "s", busy: false });
    expect(rt.projectDecision).toHaveBeenCalledWith("s", { gate: { kind: "plan" }, version: 3, verdict: "approve" });
    expect(out.text).toMatch(/^Approved the plan/);
    expect(out.continueWith).toBe('I approved. Continue with milestone "Base".');
  });

  it("/plan cancel cancels the project", async () => {
    const rt = runtime(fixtureProjectGateView({ kind: "plan" }), fixtureProjectGateView({ kind: "none" }, { expectation: { kind: "cancelled" } }));
    const out = await runProjectCommand(["cancel"], { runtime: rt, sessionId: "s", busy: false });
    expect(rt.projectDecision).toHaveBeenCalledWith("s", expect.objectContaining({ verdict: "cancel" }));
    expect(out.text).toBe("Project cancelled.");
    expect(out.continueWith).toBeNull();
  });

  it("says why an approval was refused", async () => {
    const out = await runProjectCommand(["approve", "3"], { runtime: runtime(fixtureProjectGateView({ kind: "plan" })), sessionId: "s", busy: false });
    expect(out.text).toContain("Not approved: over today's limit");
  });

  it("refuses while a turn runs, with nothing waiting, and for other verbs", async () => {
    expect((await runProjectCommand(["approve"], { runtime: runtime(fixtureProjectGateView({ kind: "plan" })), sessionId: "s", busy: true })).text).toMatch(/current turn/);
    expect((await runProjectCommand(["approve"], { runtime: runtime(undefined), sessionId: "s", busy: false })).text).toMatch(/no project/i);
    expect((await runProjectCommand(["approve"], { runtime: runtime(fixtureProjectGateView({ kind: "none" })), sessionId: "s", busy: false })).text).toMatch(/Nothing waits/);
    expect((await runProjectCommand(["cheaper"], { runtime: runtime(fixtureProjectGateView({ kind: "plan" })), sessionId: "s", busy: false })).text).toMatch(/Usage: \/plan/);
    expect((await runProjectCommand([], { runtime: runtime(undefined), sessionId: null, busy: false })).text).toMatch(/no project/i);
  });

  it("the after-turn notice appears only for an open gate", () => {
    expect(projectGateNotice(runtime(fixtureProjectGateView({ kind: "plan" })), "s")).toContain("/plan approve 3");
    expect(projectGateNotice(runtime(fixtureProjectGateView({ kind: "none" })), "s")).toBeNull();
    expect(projectGateNotice({}, "s")).toBeNull();
  });
});

describe("Telegram /plan and the plan reviewer (issue #118)", () => {
  it("shows the plan review notes and where to approve over them", async () => {
    const view = fixtureProjectGateView({ kind: "plan" }, {
      allowedVerdicts: ["approve", "edit", "cheaper", "quality", "approveOverReview", "cancel"],
      hints: ["plan review 3 by cloud:r: 7 pass, 0 warn, 1 fail; open notes below: approve over them only with a note (approveOverReview)", "plan review: scope: fail: drops the level editor"],
    });
    const out = await runProjectCommand([], { runtime: runtime(view), sessionId: "s", busy: false });
    expect(out.text).toContain("  hint: plan review: scope: fail: drops the level editor");
    expect(out.text).toContain("Approving over the open review notes (with your reason) is in the terminal or the desktop app.");
  });
});
