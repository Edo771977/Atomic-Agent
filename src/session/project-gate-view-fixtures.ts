/**
 * A plain {@link ProjectGateView} for the surfaces' tests (TUI card, CLI,
 * HTTP, sidecar). Neutral fixture refs; no runtime involved.
 */

import type { ProjectGateView } from "./project-gate-view.js";
import { allowedProjectVerdicts, type ProjectGate } from "./session-project.js";

export function fixtureProjectGateView(
  gate: ProjectGate = { kind: "plan" },
  overrides: Partial<ProjectGateView> = {},
): ProjectGateView {
  return {
    schema: 1,
    sessionId: "s1",
    cancelled: false,
    brief: {
      version: 2,
      what: "A small puzzle game",
      users: "Casual players",
      how: "A web page with a canvas",
      successCriteria: ["Runs in a browser", "Ten levels"],
      criteria: [{ id: "c1", text: "Runs in a browser" }, { id: "c2", text: "Ten levels" }],
      status: gate.kind === "brief" ? "draft" : "approved",
      draftedAfterUntrusted: false,
    },
    plan: {
      status: gate.kind === "plan" ? "draft" : "approved",
      detail: "compact",
      version: 3,
      draftedAfterUntrusted: false,
      totals: { costUsd: 0.12, ms: 90_000, unknownCostRows: 1 },
      rows: [
      {
        taskId: "t1", title: "Board and pieces", milestoneId: "m1",
        worker: "prov-a:model-a", reviewer: "prov-b:model-b",
        reason: "best measured acceptance", basis: "measured", samples: 6,
        estCostUsd: 0.12, estMs: 90_000,
        selectableWorkers: ["prov-a:model-a", "prov-c:model-c"], selectableReviewers: ["prov-b:model-b"],
      },
      {
        taskId: "t2", title: "Level screen", milestoneId: "m2",
        worker: "prov-c:model-c", reviewer: null,
        reason: "insufficient data, chosen from the preset", basis: "preset", samples: 0,
        estCostUsd: null, estMs: null,
        selectableWorkers: ["prov-a:model-a", "prov-c:model-c"], selectableReviewers: ["prov-b:model-b"],
      },
      ],
    },
    milestones: [
      { id: "m1", title: "Base", kind: "base", state: gate.kind === "milestone" ? "done" : "planned", runIds: [], updatedAt: 1, estCostUsd: 0.12, estMs: 90_000, ...(gate.kind === "milestone" ? { summary: "Board renders" } : {}) },
      { id: "m2", title: "UI", kind: "ui", state: "planned", runIds: [], updatedAt: 1, estCostUsd: null, estMs: null },
    ],
    gate,
    version: 3,
    allowedVerdicts: allowedProjectVerdicts(gate),
    violations: [],
    expectation: gate.kind === "none" ? { kind: "run_milestone", id: "m1" } : { kind: "await_person", gate },
    ...overrides,
  };
}
