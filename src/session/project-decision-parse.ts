/**
 * Validation of a fusion project decision arriving over a wire (issue
 * #39): the HTTP `POST /api/project/decision` body and the sidecar
 * `project_decision` request. Shape only; whether the gate takes it (the
 * current gate, its version, allowed verdicts, hard caps) is the
 * runtime's `projectDecision`.
 */

import { normalizeCriterionId } from "./project-criterion-id.js";
import { PROJECT_LIMITS, parsePlanTaskLessons, PERSON_BACKLOG_STATUSES, PERSON_DECISION_STATUSES, type PersonBacklogStatus, type PersonDecisionStatus, type ProjectDecision, type ProjectEdits, type ProjectGate, type ProjectVerdict } from "./session-project.js";

export const PROJECT_VERDICTS: readonly ProjectVerdict[] = ["approve", "edit", "cheaper", "quality", "cancel", "approveOverReview"];
export const MAX_PROJECT_NOTE_CHARS = 2000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseProjectGate(raw: unknown): ProjectGate | null {
  if (!isObject(raw)) return null;
  switch (raw.kind) {
    case "none":
    case "brief":
    case "plan":
      return { kind: raw.kind };
    case "milestone":
      return typeof raw.id === "string" && raw.id.length > 0 ? { kind: "milestone", id: raw.id } : null;
    default:
      return null;
  }
}

function parseEdits(raw: unknown): ProjectEdits | string {
  if (!isObject(raw)) return "edits must be an object";
  const out: ProjectEdits = {};
  if (raw.rows !== undefined) {
    if (!Array.isArray(raw.rows)) return "edits.rows must be an array";
    const rows: Array<{ taskId: string; worker?: string; reviewer?: string | null }> = [];
    for (const row of raw.rows) {
      if (!isObject(row) || typeof row.taskId !== "string") return "each edits.rows entry needs a taskId";
      if (row.worker !== undefined && typeof row.worker !== "string") return "edits.rows[].worker must be a string";
      if (row.reviewer !== undefined && row.reviewer !== null && typeof row.reviewer !== "string") {
        return "edits.rows[].reviewer must be a string or null";
      }
      rows.push({
        taskId: row.taskId,
        ...(typeof row.worker === "string" ? { worker: row.worker } : {}),
        ...(row.reviewer !== undefined ? { reviewer: row.reviewer as string | null } : {}),
      });
    }
    out.rows = rows;
  }
  if (raw.brief !== undefined) {
    if (!isObject(raw.brief)) return "edits.brief must be an object";
    const brief: Record<string, unknown> = {};
    for (const key of ["what", "users", "how"] as const) {
      const v = raw.brief[key];
      if (v === undefined) continue;
      if (typeof v !== "string") return `edits.brief.${key} must be a string`;
      brief[key] = v;
    }
    if (raw.brief.successCriteria !== undefined) {
      const c = raw.brief.successCriteria;
      const item = (x: unknown): boolean => typeof x === "string" || (isObject(x) && typeof x.id === "string" && typeof x.text === "string");
      if (!Array.isArray(c) || !c.every(item)) return "edits.brief.successCriteria must be strings or { id, text }";
      brief.successCriteria = c;
    }
    out.brief = brief as ProjectEdits["brief"];
  }
  if (raw.decisionStatus !== undefined) {
    // Issue #112: the person's status for the approved brief's decisions, at the plan gate.
    if (!isObject(raw.decisionStatus)) return "edits.decisionStatus must be an object of decision id to status";
    const status: Record<string, PersonDecisionStatus> = {};
    for (const [id, value] of Object.entries(raw.decisionStatus)) {
      if (normalizeCriterionId(id) !== id) return `edits.decisionStatus: ${JSON.stringify(id)} is not a decision id`;
      if (typeof value !== "string" || !(PERSON_DECISION_STATUSES as readonly string[]).includes(value)) {
        return `edits.decisionStatus.${id} must be one of ${PERSON_DECISION_STATUSES.join(", ")}`;
      }
      status[id] = value as PersonDecisionStatus;
    }
    out.decisionStatus = status;
  }
  if (raw.lessonStatus !== undefined) {
    if (!isObject(raw.lessonStatus)) return "edits.lessonStatus must map lesson ids to statuses";
    const entries = Object.entries(raw.lessonStatus);
    if (entries.length > PROJECT_LIMITS.lessonFiles || parsePlanTaskLessons(Object.keys(raw.lessonStatus)) === null) {
      return "edits.lessonStatus must contain valid lesson ids";
    }
    const statuses: Array<[string, "active" | "deferred"]> = [];
    for (const [id, status] of entries) {
      if (status !== "active" && status !== "deferred") return `edits.lessonStatus.${id} must be active or deferred`;
      statuses.push([id, status]);
    }
    out.lessonStatus = Object.fromEntries(statuses);
  }
  if (raw.backlogStatus !== undefined) {
    // Issue #146: the person defers a promoted backlog item at the plan gate, or sets it active again.
    if (!isObject(raw.backlogStatus)) return "edits.backlogStatus must be an object of backlog item id to status";
    const status: Record<string, PersonBacklogStatus> = {};
    for (const [id, value] of Object.entries(raw.backlogStatus)) {
      if (normalizeCriterionId(id) !== id) return `edits.backlogStatus: ${JSON.stringify(id)} is not a backlog item id`;
      if (typeof value !== "string" || !(PERSON_BACKLOG_STATUSES as readonly string[]).includes(value)) {
        return `edits.backlogStatus.${id} must be one of ${PERSON_BACKLOG_STATUSES.join(", ")}`;
      }
      status[id] = value as PersonBacklogStatus;
    }
    out.backlogStatus = status;
  }
  if (raw.note !== undefined) {
    if (typeof raw.note !== "string" || raw.note.trim().length === 0 || raw.note.length > MAX_PROJECT_NOTE_CHARS) {
      return `edits.note must be a non-empty string of at most ${MAX_PROJECT_NOTE_CHARS} characters`;
    }
    out.note = raw.note;
  }
  return out;
}

/**
 * `{gate, version, verdict, edits?}` as a decision (the milestone
 * correction is `edits.note`), or the reason
 * it is malformed (one sentence for a `400` / a failed request).
 */
export function parseProjectDecision(raw: Record<string, unknown>): ProjectDecision | string {
  const gate = parseProjectGate(raw.gate);
  if (gate === null) return 'gate must be {kind: "brief"|"plan"|"none"} or {kind: "milestone", id}';
  if (!Number.isInteger(raw.version) || (raw.version as number) < 1) {
    return "version must be a positive integer (the view's version)";
  }
  if (typeof raw.verdict !== "string" || !(PROJECT_VERDICTS as readonly string[]).includes(raw.verdict)) {
    return `verdict must be one of ${PROJECT_VERDICTS.join(", ")}`;
  }
  const decision: ProjectDecision = { gate, version: raw.version as number, verdict: raw.verdict as ProjectVerdict };
  if (raw.edits !== undefined) {
    const edits = parseEdits(raw.edits);
    if (typeof edits === "string") return edits;
    decision.edits = edits;
  }
  return decision;
}
