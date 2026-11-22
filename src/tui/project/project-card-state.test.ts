import { describe, expect, it } from "vitest";

import { reduceTuiState } from "../agent-event-reducer.js";
import { createInitialTuiState } from "../tui-state.js";
import { fakeSession } from "../test-fixtures.js";
import { fixtureProjectGateView } from "../../session/project-gate-view-fixtures.js";
import {
  projectCardActions,
  projectFieldOptions,
  reduceProjectCard,
  type ProjectCardState,
} from "./project-card-state.js";

const plan = fixtureProjectGateView({ kind: "plan" });

function shown(view = plan, full?: boolean): ProjectCardState {
  return reduceProjectCard(null, { type: "project_card_shown", sessionId: "s1", view, ...(full === undefined ? {} : { full }) })!;
}

describe("project card reducer", () => {
  it("keeps the selected backlog id on refresh and never silently targets its replacement", () => {
    const item = (id: string) => ({ id, title: id, createdAt: 1, source: "director" as const, state: "open" as const });
    const backlog = { open: 2, promoted: [], seeds: [], stale: [], items: [item("b1"), item("b2")] };
    const view = { ...plan, backlog };
    let c = reduceProjectCard(shown(view), { type: "project_card_mode_set", mode: "backlog" })!;
    c = reduceProjectCard(c, { type: "project_card_backlog_moved", delta: 1 })!;
    const reordered = { ...view, backlog: { ...backlog, items: [...backlog.items].reverse() } };
    c = reduceProjectCard(c, { type: "project_card_shown", sessionId: "s1", view: reordered })!;
    expect(c.backlogId).toBe("b2");
    const removed = { ...view, backlog: { ...backlog, items: [item("b1")] } };
    c = reduceProjectCard(c, { type: "project_card_shown", sessionId: "s1", view: removed })!;
    expect(c.backlogId).not.toBe("b1");
    expect(reduceProjectCard(c, { type: "project_card_backlog_moved", delta: 1 })?.backlogId).toBe("b1");
  });

  it("draws buttons only for the verdicts the gate allows, edit named per gate", () => {
    expect(projectCardActions(plan).map((a) => a.label)).toEqual(["approve", "edit rows", "cheaper", "quality", "cancel project"]);
    const ms = fixtureProjectGateView({ kind: "milestone", id: "m1" }, { allowedVerdicts: ["approve", "edit", "cancel"] });
    expect(projectCardActions(ms).map((a) => a.label)).toEqual(["approve", "correct", "cancel project"]);
    expect(projectCardActions(fixtureProjectGateView({ kind: "brief" })).map((a) => a.label)).toEqual(["approve", "revise", "cancel project"]);
  });

  it("closes when nothing waits on the person, unless /plan asked for the full view", () => {
    const none = fixtureProjectGateView({ kind: "none" });
    expect(reduceProjectCard(shown(), { type: "project_card_shown", sessionId: "s1", view: none })).toBeNull();
    expect(reduceProjectCard(null, { type: "project_card_shown", sessionId: "s1", view: none, full: true })?.full).toBe(true);
  });

  it("keeps the person's place on a repeated view of the same version, and starts over on a new one", () => {
    let card = shown();
    card = reduceProjectCard(card, { type: "project_card_cursor_moved", delta: 2 })!;
    const same = reduceProjectCard(card, { type: "project_card_shown", sessionId: "s1", view: plan })!;
    expect(same.cursor).toBe(2);
    const bumped = reduceProjectCard(card, { type: "project_card_shown", sessionId: "s1", view: { ...plan, version: 4 } })!;
    expect(bumped.cursor).toBe(0);
  });

  it("shows the runtime's answer after a decision (the live re-estimate), clearing pending", () => {
    let card = reduceProjectCard(shown(), { type: "project_card_pending" })!;
    const answer = { ...plan, version: 4, plan: { ...plan.plan!, totals: { costUsd: 0.5, ms: 1000, unknownCostRows: 0 } } };
    card = reduceProjectCard(card, { type: "project_card_shown", sessionId: "s1", view: answer })!;
    expect(card.pending).toBe(false);
    expect(card.view.plan?.totals.costUsd).toBe(0.5);
  });

  it("keeps /plan's full view across the runtime's updates of the same chat", () => {
    const card = reduceProjectCard(shown(plan, true), { type: "project_card_shown", sessionId: "s1", view: { ...plan, version: 9 } })!;
    expect(card.full).toBe(true);
  });

  it("cycles a reviewer through the selectable members and none", () => {
    expect(projectFieldOptions(plan, 0, "reviewer")).toEqual(["prov-b:model-b", null]);
    expect(projectFieldOptions(plan, 1, "worker")).toEqual(["prov-a:model-a", "prov-c:model-c"]);
  });

  it("follows project_gate events of the chat on screen only", () => {
    const base = createInitialTuiState(fakeSession({ sessionId: "s1" }));
    const other = reduceTuiState(base, { type: "agent_event", event: { type: "project_gate", sessionId: "s2", view: plan } });
    expect(other.projectCard).toBeNull();
    const mine = reduceTuiState(base, { type: "agent_event", event: { type: "project_gate", sessionId: "s1", view: plan } });
    expect(mine.projectCard?.view.version).toBe(3);
  });
});
