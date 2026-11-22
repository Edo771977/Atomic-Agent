/**
 * Issue #39: what the window may send main about a fusion project
 * (`agent:project`, `agent:projectDecision`). Validated here like the
 * approval IPC: a decision is rebuilt field by field, so nothing the page
 * adds reaches the agent, and what the route would refuse with `400`
 * (src/session/project-decision-parse.ts) is refused before it leaves the
 * app. Whether the gate takes it (its version, the allowed verdicts, hard
 * caps, a running turn) stays the agent's to say.
 *
 * Issue #146: `agent:projectBacklog`, the person's call on a backlog item
 * (`POST /api/project/backlog`, the HTTP form of the sidecar's
 * `project_backlog_decision`), checked the same way: a strict session and
 * item id and only `promoted`, `dropped` or `open`. Between turns only,
 * which the agent says (`turn-running`).
 */

export const PROJECT_VERDICTS = ["approve", "edit", "cheaper", "quality", "cancel", "approveOverReview"] as const;
export type ProjectVerdict = (typeof PROJECT_VERDICTS)[number];
/** The milestone correction's bound, as the agent's `MAX_PROJECT_NOTE_CHARS`. */
export const MAX_PROJECT_NOTE_CHARS = 2000;
const MAX_ID_CHARS = 200;
const MAX_ROWS = 500;
const PROJECT_DECISION_STATUSES = ["active", "deferred", "informational"] as const;
type ProjectDecisionStatus = (typeof PROJECT_DECISION_STATUSES)[number];

export type ProjectGateRef = { kind: "brief" } | { kind: "plan" } | { kind: "none" } | { kind: "milestone"; id: string };

export interface ProjectDecisionBody {
  session: string;
  gate: ProjectGateRef;
  version: number;
  verdict: ProjectVerdict;
  edits?: {
    rows?: Array<{ taskId: string; worker?: string; reviewer?: string | null }>;
    note?: string;
    decisionStatus?: Record<string, ProjectDecisionStatus>;
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_ID_CHARS && !/[\r\n]/.test(v);

export const PROJECT_BACKLOG_STATES = ["promoted", "dropped", "open"] as const;
export type ProjectBacklogState = (typeof PROJECT_BACKLOG_STATES)[number];
/** The core's `PROJECT_LIMITS.id`: a backlog item id is one word of at most this many characters. */
const MAX_BACKLOG_ID_CHARS = 64;

export interface ProjectBacklogBody {
  session: string;
  item: string;
  state: ProjectBacklogState;
}

/** Issue #146: `{sessionId, item, state}` from the window, as the route's `{session, item, state}`, or why not. */
export function parseProjectBacklogIpc(raw: unknown): { ok: true; body: ProjectBacklogBody } | { ok: false; error: string } {
  if (!isObject(raw)) return { ok: false, error: "a backlog call must be an object" };
  if (!isId(raw.sessionId)) return { ok: false, error: "session required" };
  const item = raw.item;
  if (typeof item !== "string" || item.length > MAX_BACKLOG_ID_CHARS || !/^\S+$/.test(item)) {
    return { ok: false, error: "item must be a backlog item's id" };
  }
  const state = PROJECT_BACKLOG_STATES.find((s) => s === raw.state);
  if (!state) return { ok: false, error: "state must be promoted, dropped or open" };
  return { ok: true, body: { session: raw.sessionId, item, state } };
}

/** Issue #109: one absolute folder (POSIX or Windows) for the projects list's forget / resume, or null. */
export function parseProjectFolderIpc(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096 || /[\r\n\0]/.test(raw)) return null;
  return raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("\\\\") ? raw : null;
}

/** A session id for `GET /api/project`, or null. */
export function parseProjectSessionIpc(raw: unknown): string | null {
  return isId(raw) ? raw : null;
}

function parseGate(raw: unknown): ProjectGateRef | null {
  if (!isObject(raw)) return null;
  if (raw.kind === "brief" || raw.kind === "plan" || raw.kind === "none") return { kind: raw.kind };
  if (raw.kind === "milestone" && isId(raw.id)) return { kind: "milestone", id: raw.id };
  return null;
}

export function parseProjectDecisionIpc(raw: unknown): { ok: true; body: ProjectDecisionBody } | { ok: false; error: string } {
  if (!isObject(raw)) return { ok: false, error: "a decision must be an object" };
  if (!isId(raw.session)) return { ok: false, error: "session required" };
  const gate = parseGate(raw.gate);
  if (!gate) return { ok: false, error: "gate must be brief, plan or a milestone with its id" };
  if (!Number.isInteger(raw.version) || (raw.version as number) < 1) return { ok: false, error: "version must be the view's version" };
  const verdict = PROJECT_VERDICTS.find((v) => v === raw.verdict);
  if (!verdict) return { ok: false, error: `verdict must be one of ${PROJECT_VERDICTS.join(", ")}` };
  const body: ProjectDecisionBody = { session: raw.session, gate, version: raw.version as number, verdict };
  if (raw.edits !== undefined) {
    if (!isObject(raw.edits)) return { ok: false, error: "edits must be an object" };
    const edits: NonNullable<ProjectDecisionBody["edits"]> = {};
    if (raw.edits.rows !== undefined) {
      if (!Array.isArray(raw.edits.rows) || raw.edits.rows.length > MAX_ROWS) return { ok: false, error: "edits.rows must be a list of rows" };
      const rows: NonNullable<typeof edits.rows> = [];
      for (const row of raw.edits.rows) {
        if (!isObject(row) || !isId(row.taskId)) return { ok: false, error: "each row needs its taskId" };
        if (row.worker !== undefined && !isId(row.worker)) return { ok: false, error: "a row's worker must be a member id" };
        if (row.reviewer !== undefined && row.reviewer !== null && !isId(row.reviewer)) {
          return { ok: false, error: "a row's reviewer must be a member id or none" };
        }
        rows.push({
          taskId: row.taskId,
          ...(row.worker !== undefined ? { worker: row.worker as string } : {}),
          ...(row.reviewer !== undefined ? { reviewer: row.reviewer as string | null } : {}),
        });
      }
      edits.rows = rows;
    }
    if (raw.edits.decisionStatus !== undefined) {
      if (gate.kind !== "plan" || verdict !== "edit" || !isObject(raw.edits.decisionStatus)) {
        return { ok: false, error: "decision statuses can only be edited at the plan gate" };
      }
      const statuses: Array<[string, ProjectDecisionStatus]> = [];
      for (const [id, value] of Object.entries(raw.edits.decisionStatus)) {
        const status = PROJECT_DECISION_STATUSES.find((candidate) => candidate === value);
        if (!/^[a-z0-9-]{1,32}$/.test(id) || status === undefined) {
          return { ok: false, error: "decision statuses require a valid id and active, deferred or informational status" };
        }
        statuses.push([id, status]);
      }
      if (statuses.length === 0) return { ok: false, error: "name at least one decision" };
      edits.decisionStatus = Object.fromEntries(statuses);
    }
    if (raw.edits.note !== undefined) {
      const note = raw.edits.note;
      if (typeof note !== "string" || note.trim().length === 0 || note.length > MAX_PROJECT_NOTE_CHARS) {
        return { ok: false, error: `the correction must be 1 to ${MAX_PROJECT_NOTE_CHARS} characters` };
      }
      edits.note = note;
    }
    body.edits = edits;
  }
  if (verdict === "approveOverReview" && !body.edits?.note) {
    return { ok: false, error: "a reason is required to approve over review" };
  }
  return { ok: true, body };
}
