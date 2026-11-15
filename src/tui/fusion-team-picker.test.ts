import { describe, expect, it } from "vitest";

import type { UserLlmRunModeConfig } from "../config/llm-run-mode-config.js";
import { withSessionFusionDirector, withSessionFusionWorker } from "../session/session-fusion-team.js";
import { parseTeamMember } from "../llm/run-mode/fusion-team.js";
import { needsDirectorPick, teamPickerState } from "./fusion-team-picker.js";

const runMode: UserLlmRunModeConfig = {
  mode: "fusion",
  fusion: {
    orchestratorProvider: "cloud",
    team: { directors: ["cloud:model-a", "cli:model-d", "gone:model-z"], workers: ["cli:model-w"] },
  },
};
const usable = (providerId: string): boolean => providerId !== "gone";
const m = (ref: string) => parseTeamMember(ref)!;

describe("the TUI's fusion team picker (issue #37)", () => {
  it("lists the usable members and the chat's choice", () => {
    const metadata = withSessionFusionWorker(withSessionFusionDirector({}, m("cli:model-d"), 1), m("cli:model-w"), 1);
    expect(teamPickerState(runMode, metadata, usable)).toEqual({
      directors: ["cloud:model-a", "cli:model-d"], workers: ["cli:model-w"], director: "cli:model-d", worker: "cli:model-w",
    });
    expect(teamPickerState({ mode: "fusion" }, {}, usable)).toBeNull();
  });

  it("asks on the first submit only with several usable directors, fusion on, and none chosen", () => {
    expect(needsDirectorPick(runMode, {}, usable)).toBe(true);
    expect(needsDirectorPick(runMode, withSessionFusionDirector({}, m("cloud:model-a"), 1), usable)).toBe(false);
    expect(needsDirectorPick(runMode, {}, (id) => id === "cloud")).toBe(false);
    expect(needsDirectorPick({ ...runMode, mode: "cloud" }, {}, usable)).toBe(false);
    expect(needsDirectorPick({ mode: "fusion" }, {}, usable)).toBe(false);
  });
});
