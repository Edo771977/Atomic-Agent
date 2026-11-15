import { describe, expect, it } from "vitest";

import { fakeSession } from "../test-fixtures.js";
import { createInitialTuiState } from "../tui-state.js";
import { reduceTuiState } from "../agent-event-reducer.js";
import { selectComposerSwitchRows, selectComposerSwitchTitle } from "./composer-switch-rows.js";

/**
 * Issue #37: the fusion team's pickers. The chat orchestrator shows the
 * team (`composer_team_shown`) and opens the `director` or `teamWorker`
 * switch on the first submit of a chat with several directors, or on
 * `/director` / `/worker`; Enter on a row stamps the session.
 */
describe("fusion team pickers", () => {
  const shown = (director: string | null, worker: string | null = null) =>
    reduceTuiState(createInitialTuiState(fakeSession()), {
      type: "composer_team_shown",
      team: { directors: ["cloud:model-a", "cli:model-d"], workers: ["cli:model-w"], director, worker },
    });

  it("lists the directors, the session's one marked active, and lands on it", () => {
    const opened = reduceTuiState(shown("cli:model-d"), { type: "composer_switch_opened", kind: "director" });
    const rows = selectComposerSwitchRows(opened, "director");
    expect(rows.map((r) => [r.label, r.active])).toEqual([["cloud:model-a", false], ["cli:model-d", true]]);
    expect(rows[1]?.intent).toEqual({ kind: "fusionTeamMember", role: "director", member: "cli:model-d" });
    expect(opened.composerSwitch).toMatchObject({ kind: "director", cursor: 1 });
    expect(selectComposerSwitchTitle("director", opened)).toBe("Fusion director");
  });

  it("lists the workers with a row that clears the preference", () => {
    const rows = selectComposerSwitchRows(shown(null, "cli:model-w"), "teamWorker");
    expect(rows.map((r) => [r.label, r.active])).toEqual([["cli:model-w", true], ["Task's own pick", false]]);
    expect(rows[1]?.intent).toEqual({ kind: "fusionTeamMember", role: "worker", member: null });
    expect(selectComposerSwitchTitle("teamWorker")).toBe("Preferred worker");
  });

  it("has no rows before the team was shown", () => {
    expect(selectComposerSwitchRows(createInitialTuiState(fakeSession()), "director")).toEqual([]);
  });
});
