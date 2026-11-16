import { describe, expect, it, vi } from "vitest";

import { fixtureProjectGateView } from "../session/project-gate-view-fixtures.js";
import type { ProjectGateView } from "../session/project-gate-view.js";
import { parseRunArgs } from "./run-agent.js";
import { settleProjectGate } from "./run-project-gate.js";

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
});
