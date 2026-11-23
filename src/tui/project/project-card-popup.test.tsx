import { Box } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import { pathToFileURL } from "node:url";

import { FIXTURE_SHOT_PATH, fixtureProjectGateView, withFixtureMilestoneEvidence } from "../../session/project-gate-view-fixtures.js";
import { wrapOsc8 } from "../render/osc8-link.js";
import { ProjectCardPopup } from "./project-card-popup.js";
import { reduceProjectCard } from "./project-card-state.js";

describe("ProjectCardPopup", () => {
  it("draws the card and keeps the buttons when the body is taller than the pane", () => {
    const card = reduceProjectCard(null, { type: "project_card_shown", sessionId: "s1", view: fixtureProjectGateView({ kind: "plan" }), full: true })!;
    const { lastFrame, unmount } = render(
      <Box flexDirection="column" position="relative" width={100} height={12}>
        <ProjectCardPopup card={card} availableRows={12} availableColumns={100} />
      </Box>,
    );
    const frame = lastFrame() ?? "";
    unmount();
    expect(frame).toContain("PROJECT PLAN — YOUR APPROVAL");
    expect(frame).toContain("approve");
    expect(frame).toContain("esc put away");
  });

  it("shows PgDn before the end and reports the last visible lesson row", async () => {
    const lesson = {
      id: "storage", hash: "0".repeat(64), title: "Storage", always: true, touches: [],
      declaredStatus: "active", approvedByPerson: false, source: "person",
      sections: { decided: "Review this. ".repeat(60), triedAndRuledOut: "", watchOut: "LAST LESSON LINE" },
    } as const;
    const base = reduceProjectCard(null, { type: "project_card_shown", sessionId: "s1", view: fixtureProjectGateView({ kind: "plan" }) })!;
    const card = reduceProjectCard(base, {
      type: "project_card_lessons_loaded", sessionId: "s1", panel: {
        rows: [{ id: lesson.id, hash: lesson.hash, lesson: { ...lesson, touches: [] }, hasChoice: false,
          status: { personState: null, approvedByPerson: false, effectiveStatus: "unapproved", stale: false } }], problems: [],
      },
    })!;
    const detail = reduceProjectCard(card, { type: "project_card_lesson_detail", open: true })!;
    const onLessonEndVisible = vi.fn();
    const popup = (scroll: number) => (
      <Box position="relative" width={72} height={8}>
        <ProjectCardPopup card={{ ...detail, scroll }} availableRows={8} availableColumns={72} onLessonEndVisible={onLessonEndVisible} />
      </Box>
    );
    const { lastFrame, rerender, unmount } = render(popup(0));
    try {
      await vi.waitFor(() => expect(lastFrame()).toContain("More below · PgDn"));
      expect(lastFrame()).not.toContain("LAST LESSON LINE");
      expect(onLessonEndVisible).not.toHaveBeenCalled();
      rerender(popup(100));
      await vi.waitFor(() => expect(lastFrame()).toContain("LAST LESSON LINE"));
      expect(onLessonEndVisible).toHaveBeenCalledWith("s1", lesson.id, lesson.hash);
    } finally {
      unmount();
    }
  });

  it("draws a picture's path as an OSC 8 file link (issue #40)", () => {
    const view = withFixtureMilestoneEvidence(fixtureProjectGateView({ kind: "milestone", id: "m1" }, { allowedVerdicts: ["approve", "edit", "cancel"] }));
    const card = reduceProjectCard(null, { type: "project_card_shown", sessionId: "s1", view })!;
    const { lastFrame, unmount } = render(
      <Box flexDirection="column" position="relative" width={100} height={40}>
        <ProjectCardPopup card={card} availableRows={40} availableColumns={100} />
      </Box>,
    );
    const frame = lastFrame() ?? "";
    unmount();
    expect(frame).toContain(wrapOsc8(FIXTURE_SHOT_PATH, pathToFileURL(FIXTURE_SHOT_PATH).href));
  });
});
