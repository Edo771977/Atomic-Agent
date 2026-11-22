import { describe, expect, it, vi } from "vitest";
import type { Key } from "ink";

import { handleAppKey, type AppKeyContext } from "../app-key-bindings.js";
import { createInitialTuiState, type TuiState } from "../tui-state.js";
import { fakeSession } from "../test-fixtures.js";
import { reduceTuiState } from "../agent-event-reducer.js";
import { fixtureProjectGateView } from "../../session/project-gate-view-fixtures.js";
import type { ProjectGate } from "../../session/session-project.js";
import type { ProjectGateView } from "../../session/project-gate-view.js";

const KEY: Key = {
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
  pageDown: false, pageUp: false, return: false, escape: false, ctrl: false,
  shift: false, tab: false, backspace: false, delete: false, meta: false,
} as Key;

function withCard(view: ProjectGateView): TuiState {
  const base = createInitialTuiState(fakeSession({ sessionId: "s1" }));
  return reduceTuiState(base, { type: "project_card_shown", sessionId: "s1", view });
}

/** Runs keys through handleAppKey, folding dispatched actions into the state. */
function harness(start: TuiState) {
  let state = start;
  const callbacks = {
    onApprovalDecision: vi.fn(),
    onAbort: vi.fn(),
    onQuit: vi.fn(),
    onProjectDecision: vi.fn(),
    onProjectBacklogDecision: vi.fn(),
    onProjectReviseBrief: vi.fn(),
  };
  const press = (input: string, key: Partial<Key> = {}): boolean => {
    const ctx = {
      state,
      dispatch: (a: Parameters<typeof reduceTuiState>[1]) => { state = reduceTuiState(state, a); },
      callbacks,
      ctrlCArmed: false,
      setCtrlCArmed: vi.fn(),
      sidebarVisible: true,
      menuLeaderArmed: false,
      setMenuLeaderArmed: vi.fn(),
      activateMenuNode: vi.fn(),
      activateComposerSwitch: vi.fn(),
    } as unknown as AppKeyContext;
    return handleAppKey(input, { ...KEY, ...key } as Key, ctx);
  };
  return { press, callbacks, get state() { return state; } };
}

it("only explicit backlog action keys decide, including between gates", () => {
  const view = fixtureProjectGateView({ kind: "none" });
  view.backlog = { open: 1, items: [{ id: "b1", title: "Export", source: "director", createdAt: 1, state: "open" }],
    promoted: [], seeds: [], stale: [{ id: "b2", state: "dropped", reason: "removed" }] };
  const initial = reduceTuiState(withCard(view), { type: "project_card_shown", sessionId: "s1", view, full: true });
  for (const [key, state] of [["p", "promoted"], ["d", "dropped"], ["r", "open"]]) {
    const h = harness(initial);
    h.press("b");
    h.press("", { downArrow: true });
    h.press("", { return: true });
    expect(h.callbacks.onProjectBacklogDecision).not.toHaveBeenCalled();
    if (key !== "r") h.press("", { upArrow: true });
    h.press(key!);
    expect(h.callbacks.onProjectBacklogDecision).toHaveBeenCalledExactlyOnceWith("s1", { id: key === "r" ? "b2" : "b1", state });
    expect(h.callbacks.onProjectDecision).not.toHaveBeenCalled();
  }
});

it("does not promote an already promoted item again and reset its plan receipt", () => {
  const view = fixtureProjectGateView({ kind: "plan" });
  view.backlog = { open: 0, items: [{ id: "b1", title: "Export", source: "director", createdAt: 1, state: "promoted", plannedIn: 4 }],
    promoted: [], seeds: [], stale: [] };
  const h = harness(withCard(view));
  h.press("b");
  h.press("p");
  expect(h.callbacks.onProjectBacklogDecision).not.toHaveBeenCalled();
});

const plan: ProjectGate = { kind: "plan" };
const milestone: ProjectGate = { kind: "milestone", id: "m1" };

describe("project card keys", () => {
  it("approves with `a`, sending the gate and the version the person saw", () => {
    const h = harness(withCard(fixtureProjectGateView(plan)));
    expect(h.press("a")).toBe(true);
    expect(h.callbacks.onProjectDecision).toHaveBeenCalledWith("s1", {
      gate: plan, version: 3, verdict: "approve",
    });
    expect(h.state.projectCard?.pending).toBe(true);
  });

  it("runs the focused button with enter after moving along the allowed verdicts", () => {
    const h = harness(withCard(fixtureProjectGateView(plan)));
    // approve, edit, cheaper, quality, cancel
    h.press("", { rightArrow: true });
    h.press("", { rightArrow: true });
    h.press("", { return: true });
    expect(h.callbacks.onProjectDecision).toHaveBeenCalledWith("s1", expect.objectContaining({ verdict: "cheaper" }));
  });

  it("ignores a letter whose verdict the gate does not allow", () => {
    const h = harness(withCard(fixtureProjectGateView({ kind: "brief" })));
    expect(h.press("c")).toBe(true);
    expect(h.callbacks.onProjectDecision).not.toHaveBeenCalled();
  });

  it("owns letters while open, so they never reach the composer", () => {
    const h = harness(withCard(fixtureProjectGateView(plan)));
    expect(h.press("z")).toBe(true);
  });

  it("puts the card away with esc and leaves ctrl+c to the app", () => {
    const h = harness(withCard(fixtureProjectGateView(plan)));
    h.press("c", { ctrl: true });
    expect(h.callbacks.onProjectDecision).not.toHaveBeenCalled();
    expect(h.state.projectCard).not.toBeNull();
    h.press("", { escape: true });
    expect(h.state.projectCard).toBeNull();
  });

  it("does not answer for another chat's card", () => {
    const base = createInitialTuiState(fakeSession({ sessionId: "s1" }));
    const state = reduceTuiState(base, { type: "project_card_shown", sessionId: "other", view: fixtureProjectGateView(plan) });
    const h = harness(state);
    expect(h.press("a")).toBe(false);
    expect(h.callbacks.onProjectDecision).not.toHaveBeenCalled();
  });

  it("waits while a decision is in flight", () => {
    const h = harness(withCard(fixtureProjectGateView(plan)));
    h.press("a");
    h.press("a");
    expect(h.callbacks.onProjectDecision).toHaveBeenCalledTimes(1);
  });

  it("edits a row's worker and reviewer among the row's selectable members", () => {
    const h = harness(withCard(fixtureProjectGateView(plan)));
    h.press("e");
    expect(h.state.projectCard?.mode).toBe("edit");
    h.press("", { rightArrow: true }); // t1 worker: model-a → model-c
    h.press("", { tab: true }); // reviewer field
    h.press("", { rightArrow: true }); // model-b → none
    h.press("", { return: true });
    expect(h.callbacks.onProjectDecision).toHaveBeenCalledWith("s1", {
      gate: plan, version: 3, verdict: "edit",
      edits: { rows: [{ taskId: "t1", worker: "prov-c:model-c", reviewer: null }] },
    });
  });

  it("refuses an edit that changes nothing, with a line on the card", () => {
    const h = harness(withCard(fixtureProjectGateView(plan)));
    h.press("e");
    h.press("", { return: true });
    expect(h.callbacks.onProjectDecision).not.toHaveBeenCalled();
    expect(h.state.projectCard?.error).toMatch(/nothing changed/i);
  });

  it("esc in edit mode drops the picks and goes back to the buttons", () => {
    const h = harness(withCard(fixtureProjectGateView(plan)));
    h.press("e");
    h.press("", { rightArrow: true });
    h.press("", { escape: true });
    expect(h.state.projectCard?.mode).toBe("actions");
    expect(h.state.projectCard?.picks).toEqual({});
  });

  it("corrects a milestone with a note typed on the card", () => {
    const view = fixtureProjectGateView(milestone, { allowedVerdicts: ["approve", "edit", "cancel"] });
    const h = harness(withCard(view));
    h.press("e");
    expect(h.state.projectCard?.mode).toBe("note");
    for (const ch of "Bigger tiles") h.press(ch);
    h.press("", { backspace: true });
    h.press("s");
    h.press("", { return: true });
    expect(h.callbacks.onProjectDecision).toHaveBeenCalledWith("s1", {
      gate: milestone, version: 3, verdict: "edit", edits: { note: "Bigger tiles" },
    });
  });

  it("approves over an open review with `o` and a reason typed on the card (issue #98)", () => {
    const view = fixtureProjectGateView(milestone, { allowedVerdicts: ["approve", "edit", "approveOverReview", "cancel"] } as Partial<ProjectGateView>);
    const h = harness(withCard(view));
    h.press("o");
    expect(h.state.projectCard?.mode).toBe("note");
    h.press("", { return: true });
    expect(h.callbacks.onProjectDecision).not.toHaveBeenCalled();
    for (const ch of "reviewer unreachable; tests pass") h.press(ch);
    h.press("", { return: true });
    expect(h.callbacks.onProjectDecision).toHaveBeenCalledWith("s1", {
      gate: milestone, version: 3, verdict: "approveOverReview", edits: { note: "reviewer unreachable; tests pass" },
    });
  });

  it("does not send an empty correction", () => {
    const view = fixtureProjectGateView(milestone, { allowedVerdicts: ["approve", "edit", "cancel"] });
    const h = harness(withCard(view));
    h.press("e");
    h.press("", { return: true });
    expect(h.callbacks.onProjectDecision).not.toHaveBeenCalled();
  });

  it("revise at the brief hands over to the composer", () => {
    const h = harness(withCard(fixtureProjectGateView({ kind: "brief" })));
    h.press("e");
    expect(h.callbacks.onProjectReviseBrief).toHaveBeenCalled();
    expect(h.state.projectCard).toBeNull();
  });

  it("scrolls the card with page keys", () => {
    const h = harness(withCard(fixtureProjectGateView(plan)));
    h.press("", { pageDown: true });
    expect(h.state.projectCard?.scroll).toBeGreaterThan(0);
  });

  it("defers the active decisions no task cites with `d` at the plan gate (issue #112)", () => {
    const decisions = [
      { id: "d1", text: "Use SQLite", status: "active" as const, citedBy: ["t1"] },
      { id: "d2", text: "No new dependencies", status: "active" as const, citedBy: [] },
      { id: "d3", text: "Formal tone", status: "informational" as const, citedBy: [] },
    ];
    const h = harness(withCard(fixtureProjectGateView(plan, { decisions })));
    expect(h.press("d")).toBe(true);
    expect(h.callbacks.onProjectDecision).toHaveBeenCalledWith("s1", {
      gate: plan, version: 3, verdict: "edit", edits: { decisionStatus: { d2: "deferred" } },
    });
    // Nothing to defer or set back: no `d`.
    const covered = harness(withCard(fixtureProjectGateView(plan, { decisions: decisions.slice(0, 1) })));
    covered.press("d");
    expect(covered.callbacks.onProjectDecision).not.toHaveBeenCalled();
    // Every uncited one already set aside: `d` sets them back to active (review).
    const setAside = harness(withCard(fixtureProjectGateView(plan, { decisions: [decisions[0]!, { ...decisions[1]!, status: "deferred" as const }, decisions[2]!] })));
    expect(setAside.press("d")).toBe(true);
    expect(setAside.callbacks.onProjectDecision).toHaveBeenCalledWith("s1", {
      gate: plan, version: 3, verdict: "edit", edits: { decisionStatus: { d2: "active", d3: "active" } },
    });
  });
});
