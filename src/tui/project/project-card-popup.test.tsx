import { Box } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { fixtureProjectGateView } from "../../session/project-gate-view-fixtures.js";
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
});
