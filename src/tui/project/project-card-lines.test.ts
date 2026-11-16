import { describe, expect, it } from "vitest";

import { fixtureProjectGateView } from "../../session/project-gate-view-fixtures.js";
import type { ProjectGateView } from "../../session/project-gate-view.js";
import { projectCardLines, projectResumeLine } from "./project-card-lines.js";
import { reduceProjectCard, type ProjectCardState } from "./project-card-state.js";

function card(view: ProjectGateView, full?: boolean): ProjectCardState {
  return reduceProjectCard(null, { type: "project_card_shown", sessionId: "s1", view, ...(full ? { full } : {}) })!;
}

const text = (c: ProjectCardState): string =>
  projectCardLines(c, 90).map((l) => l.segments.map((s) => s.text).join("")).join("\n");

describe("project card lines", () => {
  it("compact: brief line, totals with unpriced rows, buttons; no row table", () => {
    const out = text(card(fixtureProjectGateView({ kind: "plan" })));
    expect(out).toContain("PROJECT PLAN — YOUR APPROVAL");
    expect(out).toContain("What: A small puzzle game");
    expect(out).toContain("Total: 2 tasks · $0.12 (+1 task unpriced) · ~1m30s");
    expect(out).not.toContain("Board and pieces");
    expect(out).toContain("/plan shows the full plan");
    expect(out).toMatch(/a approve .* e edit rows .* c cheaper .* q quality .* x cancel project/);
  });

  it("full (view.detail or /plan): every row with worker, reviewer, estimate and basis", () => {
    const out = text(card(fixtureProjectGateView({ kind: "plan" }), true));
    expect(out).toContain("t1 Board and pieces [m1]");
    expect(out).toContain("worker model-a · review model-b · $0.12 · ~1m30s");
    expect(out).toContain("measured (6 runs): best measured acceptance");
    expect(out).toContain("worker model-c · review no review · cost unknown · time unknown");
    expect(out).toContain("preset: insufficient data, chosen from the preset");
    expect(out).toContain("• Ten levels");
    expect(text(card(fixtureProjectGateView({ kind: "plan" }, { detail: "full" })))).toContain("t2 Level screen");
  });

  it("warns on a brief drafted after untrusted content", () => {
    const base = fixtureProjectGateView({ kind: "brief" });
    const out = text(card({ ...base, brief: { ...base.brief!, draftedAfterUntrusted: true } }));
    expect(out).toMatch(/drafted after outside content/);
    expect(out).toContain("• Runs in a browser");
  });

  it("lists violations, hard ones marked", () => {
    const out = text(card(fixtureProjectGateView({ kind: "plan" }, {
      violations: [
        { kind: "daily-limit", hard: true, message: "over today's limit" },
        { kind: "local-slots", hard: false, message: "local tasks run in turns" },
      ],
    })));
    expect(out).toContain("✕ over today's limit");
    expect(out).toContain("! local tasks run in turns");
  });

  it("milestone gate: the milestone's summary and the correct button", () => {
    const out = text(card(fixtureProjectGateView({ kind: "milestone", id: "m1" }, { allowedVerdicts: ["approve", "edit", "cancel"] })));
    expect(out).toContain("MILESTONE Base DONE — YOUR REVIEW");
    expect(out).toContain("Board renders");
    expect(out).toContain("e correct");
  });

  it("note mode shows the typed correction", () => {
    let c = card(fixtureProjectGateView({ kind: "milestone", id: "m1" }, { allowedVerdicts: ["approve", "edit", "cancel"] }));
    c = reduceProjectCard(c, { type: "project_card_mode_set", mode: "note" })!;
    c = reduceProjectCard(c, { type: "project_card_note_set", note: "bigger tiles" })!;
    expect(text(c)).toContain("bigger tiles");
  });
});

describe("project resume line", () => {
  it("says what was done last and what is next", () => {
    const v = fixtureProjectGateView({ kind: "none" }, {
      milestones: [
        { id: "m1", title: "Base", kind: "base", state: "reviewed", runIds: ["r1"], updatedAt: 1 },
        { id: "m2", title: "UI", kind: "ui", state: "approved", runIds: [], updatedAt: 1 },
      ],
      expectation: { kind: "run_milestone", id: "m2" },
    });
    expect(projectResumeLine(v)).toBe("Project — last done: Base · next: UI");
  });

  it("offers /fusion resume for a milestone cut off mid-run", () => {
    const v = fixtureProjectGateView({ kind: "none" }, {
      milestones: [{ id: "m1", title: "Base", kind: "base", state: "in_progress", runIds: ["r1"], updatedAt: 1 }],
      expectation: { kind: "run_milestone", id: "m1" },
    });
    expect(projectResumeLine(v)).toBe("Project — last done: nothing yet · next: Base · Base was cut off mid-run: /fusion resume continues it");
  });

  it("points at /plan for a gate waiting on the person; nothing for a cancelled project", () => {
    expect(projectResumeLine(fixtureProjectGateView({ kind: "plan" }))).toContain("next: your approval of the plan (/plan)");
    expect(projectResumeLine(fixtureProjectGateView({ kind: "none" }, { expectation: { kind: "cancelled" } }))).toBeNull();
  });
});
