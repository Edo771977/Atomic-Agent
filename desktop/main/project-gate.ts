/**
 * Issue #39, desktop half: the fusion project gate as the agent sends it.
 *
 * `GET /api/events` carries two kinds of frame: `approval_request` (the
 * approval cards) and `project_gate` `{ session_id, view }` (the project
 * card). A chat stream with extensions carries the same view as
 * `event: project_gate` (`object: "atomic.project_gate"`). Both reach the
 * app as the client's `project` event, `{ sessionId, view }`; before this
 * the events frame went out as an approval without an `approvalId` and the
 * window dropped it.
 *
 * The view is the agent's `ProjectGateView` (src/session/project-gate-view.ts);
 * only its frame is checked here (schema 1, a gate, the verdict list). The
 * card reads the rest defensively (renderer/project-card.js).
 */

export interface ProjectGateFrame {
  sessionId: string;
  view: Record<string, unknown> & { schema: 1; gate: { kind: string }; allowedVerdicts: string[] };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A `project_gate` payload as `{ sessionId, view }`, or null when it is not one. */
export function readProjectGateFrame(raw: unknown): ProjectGateFrame | null {
  if (!isObject(raw)) return null;
  const sessionId = raw.session_id;
  const view = raw.view;
  if (typeof sessionId !== "string" || sessionId.length === 0 || !isObject(view)) return null;
  if (view.schema !== 1 || !isObject(view.gate) || typeof view.gate.kind !== "string") return null;
  if (!Array.isArray(view.allowedVerdicts)) return null;
  return { sessionId, view: view as ProjectGateFrame["view"] };
}

/**
 * Where one `/api/events` frame goes. `project_gate` is the project card's;
 * every other frame keeps the way it always went (the approval cards, which
 * ignore what carries no `approvalId`). Null for a frame that is not JSON.
 */
export function routeEventsFrame(
  frame: { event: string; data: string },
): { channel: "approval"; payload: unknown } | { channel: "project"; payload: ProjectGateFrame } | null {
  if (frame.data === "[DONE]") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame.data);
  } catch {
    return null;
  }
  if (frame.event === "project_gate") {
    const gate = readProjectGateFrame(parsed);
    return gate ? { channel: "project", payload: gate } : null;
  }
  return { channel: "approval", payload: parsed };
}
