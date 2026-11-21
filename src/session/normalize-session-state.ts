import { validRollingSummary, validSessionCompaction } from "./session-compaction.js";
import type { SessionState } from "./session-state.js";
import { readPlanSnapshot } from "../agent/plan/plan-snapshot.js";
import { normalizeProject } from "./session-project.js";
import { readProjectRef } from "./session-project-store.js";

/**
 * Fill in the fields a parsed payload may lack. Rows written before a
 * field existed, and rows imported from other agents, are missing the
 * arrays a reader iterates (`turns`, `knownFacts`, `loadedTools`) — a
 * missing array is a crash in a list, a defaulted one is an empty row.
 *
 * Throws on a payload that is not an object at all (`null`, a number):
 * there is nothing to default, and `SessionStore.readPayload` counts
 * the throw as an unreadable row.
 */
export function normalizeSessionState(raw: unknown): SessionState {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError("session payload is not an object");
  }
  const s = raw as SessionState;
  const normalized: SessionState = {
    ...s,
    knownFacts: s.knownFacts ?? [],
    latestResult: s.latestResult ?? null,
    loadedSkills: s.loadedSkills ?? [],
    loadedTools: s.loadedTools ?? [],
    worldSnapshot: s.worldSnapshot ?? null,
    stepCount: s.stepCount ?? 0,
    turnCount: s.turnCount ?? 0,
    turns: Array.isArray(s.turns) ? s.turns : [],
    metadata: s.metadata ?? {},
    lastError: s.lastError ?? null,
  };
  if (normalized.compaction && !validSessionCompaction(normalized)) {
    delete normalized.compaction;
    normalized.compactionWarning = "Ignored an invalid context compaction checkpoint.";
  }
  // A stale rolling summary (edited, forked or already compacted history) is
  // routine and only costs speed at the next compaction: dropped silently.
  if (normalized.rollingSummary && !validRollingSummary(normalized)) delete normalized.rollingSummary;
  // The live plan (ATO-486) is drawn on reopen: a malformed one is dropped
  // rather than crashing the checklist.
  if (normalized.plan !== undefined) {
    const plan = readPlanSnapshot(normalized.plan);
    if (plan === null) delete normalized.plan;
    else normalized.plan = plan;
  }
  // The re-plan counter (ATO-609) is arithmetic on every step: anything
  // but a non-negative integer is dropped and reads as 0.
  if (normalized.stepsSinceReplan !== undefined) {
    const n: unknown = normalized.stepsSinceReplan;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) delete normalized.stepsSinceReplan;
  }
  // The fusion project (issue #39) gates delegation: a malformed one is
  // dropped whole rather than half-read.
  // Issue #109: a malformed reference reads as none; the problem is transient.
  if (normalized.projectRef !== undefined) {
    const ref = readProjectRef(normalized);
    if (ref === null) delete normalized.projectRef;
    else normalized.projectRef = ref;
  }
  delete normalized.projectProblem;
  if (normalized.project !== undefined) {
    const project = normalizeProject(normalized.project);
    if (project === undefined) delete normalized.project;
    else normalized.project = project;
  }
  return normalized;
}
