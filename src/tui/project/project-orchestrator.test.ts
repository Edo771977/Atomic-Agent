import { describe, expect, it, vi } from "vitest";

import { ChatOrchestrator } from "../chat-orchestrator.js";
import { fixtureProjectGateView } from "../../session/project-gate-view-fixtures.js";
import type { ProjectGateView } from "../../session/project-gate-view.js";

function fixture(runtime: Record<string, unknown>, busy: string[] = []) {
  const emit = vi.fn();
  const sendMessage = vi.fn();
  const notify = vi.fn();
  const app = Object.assign(Object.create(ChatOrchestrator.prototype), {
    currentController: null,
    session: { id: "s1", status: "active" },
    runtime: { turnController: { busySessionIds: () => busy }, ...runtime },
    bus: { emit },
    sendMessage,
    notify,
  }) as ChatOrchestrator;
  return { app, emit, sendMessage };
}

const plan = { gate: { kind: "plan" as const }, version: 3, verdict: "approve" as const };

describe("project decisions from the TUI", () => {
  it("takes the decided project into the chat's own session copy before the next turn", async () => {
    // B's runtime saves the decision to the store, while the TUI keeps its
    // own copy of the session and runs (and saves) the next turn on it.
    const view = fixtureProjectGateView({ kind: "none" }, { expectation: { kind: "run_milestone", id: "m1" } });
    const project = { milestones: [], gate: { kind: "none" as const }, cancelledAt: 7 };
    const f = fixture({ projectDecision: vi.fn(() => ({ ok: true as const, project, view })) });
    let projectAtSend: unknown;
    f.sendMessage.mockImplementation(() => {
      projectAtSend = (f.app as unknown as { session: { project?: unknown } }).session.project;
    });
    await f.app.decideProject("s1", plan);
    expect(f.sendMessage).toHaveBeenCalled();
    expect(projectAtSend).toBe(project);
    expect((f.app as unknown as { session: { id: string; status: string; project?: unknown } }).session).toEqual({ id: "s1", status: "active", project });
  });

  it("a cancel is merged too, though nothing is sent", async () => {
    const view = fixtureProjectGateView({ kind: "none" }, { expectation: { kind: "cancelled" } });
    const project = { milestones: [], gate: { kind: "none" as const }, cancelledAt: 9 };
    const f = fixture({ projectDecision: vi.fn(() => ({ ok: true as const, project, view })) });
    await f.app.decideProject("s1", { ...plan, verdict: "cancel" });
    expect((f.app as unknown as { session: { project?: unknown } }).session.project).toBe(project);
    expect(f.sendMessage).not.toHaveBeenCalled();
  });

  it("a turn-running refusal says to wait", async () => {
    const f = fixture({ projectDecision: vi.fn(() => ({ ok: false as const, error: { code: "turn-running", message: "x" } })) });
    await f.app.decideProject("s1", plan);
    expect(f.emit).toHaveBeenCalledWith({ type: "project_card_failed", error: expect.stringMatching(/current turn/) });
  });

  it("shows the runtime's answer and continues when the gate closed on director work", async () => {
    const view: ProjectGateView = fixtureProjectGateView({ kind: "none" }, { expectation: { kind: "run_milestone", id: "m1" } });
    const projectDecision = vi.fn(() => ({ ok: true as const, project: { milestones: [], gate: { kind: "none" as const } }, view }));
    const f = fixture({ projectDecision });
    await f.app.decideProject("s1", plan);
    expect(projectDecision).toHaveBeenCalledWith("s1", plan);
    expect(f.emit).toHaveBeenCalledWith({ type: "project_card_shown", sessionId: "s1", view });
    expect(f.sendMessage).toHaveBeenCalledWith('I approved. Continue with milestone "Base".');
  });

  it("an edit shows the re-estimated plan and starts nothing", async () => {
    const view = fixtureProjectGateView({ kind: "plan" }, { version: 4 });
    const f = fixture({ projectDecision: vi.fn(() => ({ ok: true as const, project: { milestones: [], gate: { kind: "plan" as const } }, view })) });
    await f.app.decideProject("s1", { ...plan, verdict: "edit", edits: { rows: [{ taskId: "t1", worker: "prov-c:model-c" }] } });
    expect(f.emit).toHaveBeenCalledWith({ type: "project_card_shown", sessionId: "s1", view });
    expect(f.sendMessage).not.toHaveBeenCalled();
  });

  it("puts a refusal (stale version, over a cap) on the card", async () => {
    const f = fixture({ projectDecision: vi.fn(async () => ({ ok: false as const, error: { code: "stale-version", message: "The plan changed; look again." } })) });
    await f.app.decideProject("s1", plan);
    expect(f.emit).toHaveBeenCalledWith({ type: "project_card_failed", error: "The plan changed; look again." });
  });

  it("refuses while a turn runs on the chat", async () => {
    const projectDecision = vi.fn();
    const f = fixture({ projectDecision }, ["s1"]);
    await f.app.decideProject("s1", plan);
    expect(projectDecision).not.toHaveBeenCalled();
    expect(f.emit).toHaveBeenCalledWith({ type: "project_card_failed", error: expect.stringMatching(/current turn/) });
  });

  it("/plan opens the full view, or says there is no project", () => {
    const view = fixtureProjectGateView({ kind: "none" });
    const f = fixture({ projectState: () => view });
    f.app.openProjectView();
    expect(f.emit).toHaveBeenCalledWith({ type: "project_card_shown", sessionId: "s1", view, full: true });
    const g = fixture({ projectState: () => null });
    g.app.openProjectView();
    expect(g.emit).toHaveBeenCalledWith({ type: "composer_notice", text: expect.stringMatching(/no project/) });
  });

  it("opening a chat shows where its project stands and the open gate's card", () => {
    const view = fixtureProjectGateView({ kind: "plan" });
    const f = fixture({ projectState: () => view });
    (f.app as unknown as { showProject(id: string): void }).showProject("s1");
    expect(f.emit).toHaveBeenCalledWith({ type: "system_message", text: "Project — last done: nothing yet · next: your approval of the plan (/plan)" });
    expect(f.emit).toHaveBeenCalledWith({ type: "project_card_shown", sessionId: "s1", view });
  });
});
