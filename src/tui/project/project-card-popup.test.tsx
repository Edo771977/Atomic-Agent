import { Box } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

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
