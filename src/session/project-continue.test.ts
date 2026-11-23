import { describe, expect, it } from "vitest";

import { projectContinueMessage } from "./project-continue.js";
import { fixtureProjectGateView } from "./project-gate-view-fixtures.js";

const approve = { gate: { kind: "plan" as const }, version: 3, verdict: "approve" as const };

describe("projectContinueMessage", () => {
  it("runs the next milestone once the gate closed on it", () => {
    const view = fixtureProjectGateView({ kind: "none" }, { expectation: { kind: "run_milestone", id: "m1" } });
    expect(projectContinueMessage(view, approve)).toBe('I approved. Continue with milestone "Base".');
  });

  it("carries a milestone correction", () => {
    const view = fixtureProjectGateView({ kind: "none" }, { expectation: { kind: "run_milestone", id: "m1" } });
    const msg = projectContinueMessage(view, { gate: { kind: "milestone", id: "m1" }, version: 3, verdict: "edit", edits: { note: "bigger tiles" } });
    expect(msg).toBe('Redo milestone "Base". My correction: bigger tiles');
  });

  it("asks the director to summarize proposals after the final review", () => {
    const view = fixtureProjectGateView({ kind: "none" }, {
      expectation: { kind: "complete" }, lessonProposalHint: "Summarize candidate lessons with project.lesson.propose.",
    });
    expect(projectContinueMessage(view, approve)).toMatch(/project\.lesson\.propose/);
    const override = { gate: { kind: "milestone" as const, id: "m1" }, version: 3,
      verdict: "approveOverReview" as const, edits: { note: "The exported copy is the source of truth." } };
    expect(projectContinueMessage(view, override)).toContain(override.edits.note);
  });

  it("asks for the plan after the brief", () => {
    const view = fixtureProjectGateView({ kind: "none" }, { expectation: { kind: "draft_plan" } });
    expect(projectContinueMessage(view, approve)).toMatch(/Draft the plan/);
  });

  it("sends nothing while a gate is still open, or for a cancelled or complete project", () => {
    expect(projectContinueMessage(fixtureProjectGateView({ kind: "plan" }), approve)).toBeNull();
    expect(projectContinueMessage(fixtureProjectGateView({ kind: "none" }, { expectation: { kind: "cancelled" } }), approve)).toBeNull();
    expect(projectContinueMessage(fixtureProjectGateView({ kind: "none" }, { expectation: { kind: "complete" } }), approve)).toBeNull();
  });
});
