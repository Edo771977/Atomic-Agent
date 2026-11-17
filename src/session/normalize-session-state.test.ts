import { describe, expect, it } from "vitest";

import { normalizeSessionState } from "./normalize-session-state.js";

describe("normalizeSessionState: the re-plan counter (ATO-609)", () => {
  it("keeps a valid stepsSinceReplan", () => {
    expect(normalizeSessionState({ stepsSinceReplan: 3 }).stepsSinceReplan).toBe(3);
  });

  it("drops a malformed one, so the cadence reads it as 0", () => {
    for (const bad of ["3", -1, 1.5, Number.NaN, null]) {
      const state = normalizeSessionState({ stepsSinceReplan: bad });
      expect(state).not.toHaveProperty("stepsSinceReplan");
    }
  });
});
