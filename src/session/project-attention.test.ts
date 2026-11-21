import { describe, expect, it } from "vitest";

import { compareProjectAttention, IDLE_AFTER_DAYS, PROJECT_ATTENTION_ZONES, projectAttentionZone } from "./project-attention.js";
import type { ProjectState } from "./session-project.js";

/** Issue #121 (for #109's list): which zone a project falls in, what waits for the person first. */

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;

function project(over: Partial<ProjectState> = {}, states: string[] = ["approved"]): ProjectState {
  return {
    gate: { kind: "none" },
    milestones: states.map((state, i) => ({ id: `m${i + 1}`, title: `M${i + 1}`, kind: "base", state, runIds: [], updatedAt: 1 })),
    ...over,
  } as unknown as ProjectState;
}

describe("projectAttentionZone", () => {
  it("puts an open gate first, whatever else is true", () => {
    expect(projectAttentionZone(project({ gate: { kind: "plan" } }), NOW - 90 * DAY, NOW)).toBe("needs-you");
    expect(projectAttentionZone(project({ gate: { kind: "milestone", id: "m1" }, changedOutside: ["milestone:m1"] }, ["failed"]), NOW, NOW)).toBe("needs-you");
  });

  it("a failed milestone or a project that cannot be opened is a problem", () => {
    expect(projectAttentionZone(project({}, ["reviewed", "failed"]), NOW, NOW)).toBe("problem");
    expect(projectAttentionZone(null, NOW, NOW)).toBe("problem");
  });

  it("running work is in progress, even when it has been quiet", () => {
    expect(projectAttentionZone(project({}, ["reviewed", "in_progress"]), NOW - 30 * DAY, NOW)).toBe("in-progress");
  });

  it("every milestone reviewed is done; a cancelled project too", () => {
    expect(projectAttentionZone(project({}, ["reviewed", "reviewed"]), NOW - 30 * DAY, NOW)).toBe("done");
    expect(projectAttentionZone(project({ cancelledAt: 5 }, ["approved"]), NOW, NOW)).toBe("done");
  });

  it(`no activity for ${IDLE_AFTER_DAYS} days is idle; recent waiting work stays in progress`, () => {
    expect(projectAttentionZone(project({}, ["approved"]), NOW - IDLE_AFTER_DAYS * DAY - 1, NOW)).toBe("idle");
    expect(projectAttentionZone(project({}, ["approved"]), NOW - IDLE_AFTER_DAYS * DAY + 1, NOW)).toBe("in-progress");
    expect(projectAttentionZone(project({}, []), NOW - 8 * DAY, NOW)).toBe("idle");
  });

  it("orders by zone, then the most recent activity first", () => {
    const rows = [
      { zone: "done" as const, updatedAt: 9 },
      { zone: "idle" as const, updatedAt: 1 },
      { zone: "needs-you" as const, updatedAt: 2 },
      { zone: "problem" as const },
      { zone: "needs-you" as const, updatedAt: 5 },
      { zone: "in-progress" as const, updatedAt: 3 },
    ];
    expect([...rows].sort(compareProjectAttention)).toEqual([
      { zone: "needs-you", updatedAt: 5 },
      { zone: "needs-you", updatedAt: 2 },
      { zone: "problem" },
      { zone: "in-progress", updatedAt: 3 },
      { zone: "idle", updatedAt: 1 },
      { zone: "done", updatedAt: 9 },
    ]);
    expect(PROJECT_ATTENTION_ZONES).toEqual(["needs-you", "problem", "in-progress", "idle", "done"]);
  });
});
