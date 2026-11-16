/**
 * UI state for the fusion project card (issue #39), and the pure reducer
 * over it. The card draws a {@link ProjectGateView} the runtime built;
 * every verdict goes back through `AgentRuntime.projectDecision` (the
 * orchestrator), and the card then shows the view the runtime answers
 * with, so an edit's re-estimate is the runtime's, never computed here.
 *
 * Three modes: `actions` (the verdict buttons, from
 * `view.allowedVerdicts`), `edit` (plan gate: pick a worker or reviewer
 * per row among the row's `selectable` members) and `note` (milestone
 * gate: the person's correction in their own words).
 */

import type { ProjectGateView } from "../../session/project-gate-view.js";
import type { ProjectVerdict } from "../../session/session-project.js";

export type ProjectCardMode = "actions" | "edit" | "note";
export type ProjectCardField = "worker" | "reviewer";

/** A pending per-row change in edit mode; `reviewer: null` is "no review". */
export interface ProjectCardPick {
  worker?: string;
  reviewer?: string | null;
}

export interface ProjectCardState {
  /** The session the view belongs to; the card draws and answers only on that chat. */
  sessionId: string;
  view: ProjectGateView;
  /** `/plan` asked for the full view whatever `view.detail` says. */
  full: boolean;
  mode: ProjectCardMode;
  /** Index into {@link projectCardActions} in `actions` mode. */
  cursor: number;
  /** Index into `view.rows` in `edit` mode. */
  row: number;
  field: ProjectCardField;
  picks: Record<string, ProjectCardPick>;
  note: string;
  /** First body line drawn (PgUp/PgDn), for a view taller than the pane. */
  scroll: number;
  /** A decision is in flight: keys other than Esc wait. */
  pending: boolean;
  error: string | null;
}

export interface ProjectCardActionInfo {
  verdict: ProjectVerdict;
  label: string;
  /** The plain letter that runs it in `actions` mode. */
  key: string;
}

/**
 * The buttons, in the order the runtime allows them. `edit` reads as
 * "correct" at a milestone (a note) and "revise" at the brief (the
 * person types the change in the composer and the director redrafts).
 */
export function projectCardActions(view: ProjectGateView): ProjectCardActionInfo[] {
  return view.allowedVerdicts.map((verdict) => {
    switch (verdict) {
      case "approve":
        return { verdict, label: "approve", key: "a" };
      case "edit":
        return view.gate.kind === "milestone"
          ? { verdict, label: "correct", key: "e" }
          : view.gate.kind === "brief"
            ? { verdict, label: "revise", key: "e" }
            : { verdict, label: "edit rows", key: "e" };
      case "cheaper":
        return { verdict, label: "cheaper", key: "c" };
      case "quality":
        return { verdict, label: "quality", key: "q" };
      case "cancel":
        return { verdict, label: "cancel project", key: "x" };
    }
  });
}

/** Whether the card shows the full plan (rows, criteria, every milestone). */
export function projectCardIsFull(card: Pick<ProjectCardState, "full" | "view">): boolean {
  return card.full || card.view.detail === "full";
}

/** The options for a row's field, in order; the reviewer list ends with `null` (no review). */
export function projectFieldOptions(
  view: ProjectGateView,
  row: number,
  field: ProjectCardField,
): Array<string | null> {
  const r = view.rows[row];
  if (r === undefined) return [];
  if (field === "worker") {
    return r.selectable.worker.includes(r.worker) ? [...r.selectable.worker] : [r.worker, ...r.selectable.worker];
  }
  const list: Array<string | null> = [...r.selectable.reviewer];
  if (r.reviewer !== null && !list.includes(r.reviewer)) list.unshift(r.reviewer);
  list.push(null);
  return list;
}

/** The value a row's field shows now: the pending pick, else the view's. */
export function projectFieldValue(card: ProjectCardState, row: number, field: ProjectCardField): string | null {
  const r = card.view.rows[row];
  if (r === undefined) return null;
  const pick = card.picks[r.taskId];
  if (field === "worker") return pick?.worker ?? r.worker;
  return pick !== undefined && "reviewer" in pick ? (pick.reviewer ?? null) : r.reviewer;
}

/** The changed rows of an edit, as `ProjectEdits.rows`. */
export function projectEditRows(
  card: ProjectCardState,
): Array<{ taskId: string; worker?: string; reviewer?: string | null }> {
  const out: Array<{ taskId: string; worker?: string; reviewer?: string | null }> = [];
  for (const r of card.view.rows) {
    const pick = card.picks[r.taskId];
    if (pick === undefined) continue;
    const entry: { taskId: string; worker?: string; reviewer?: string | null } = { taskId: r.taskId };
    if (pick.worker !== undefined && pick.worker !== r.worker) entry.worker = pick.worker;
    if ("reviewer" in pick && (pick.reviewer ?? null) !== r.reviewer) entry.reviewer = pick.reviewer ?? null;
    if (entry.worker !== undefined || "reviewer" in entry) out.push(entry);
  }
  return out;
}

export type ProjectCardAction =
  /** A view from the runtime: a `project_gate` event, `/plan`, a decision's answer or a chat open. */
  | { type: "project_card_shown"; sessionId: string; view: ProjectGateView; full?: boolean }
  | { type: "project_card_closed" }
  | { type: "project_card_cursor_moved"; delta: number }
  | { type: "project_card_mode_set"; mode: ProjectCardMode }
  | { type: "project_card_row_moved"; delta: number }
  | { type: "project_card_field_toggled" }
  | { type: "project_card_pick_cycled"; delta: number }
  | { type: "project_card_note_set"; note: string }
  | { type: "project_card_scrolled"; delta: number }
  | { type: "project_card_pending" }
  | { type: "project_card_failed"; error: string };

export function isProjectCardAction(action: { type: string }): action is ProjectCardAction {
  return action.type.startsWith("project_card_");
}

function fresh(sessionId: string, view: ProjectGateView, full: boolean): ProjectCardState {
  return {
    sessionId, view, full, mode: "actions", cursor: 0, row: 0, field: "worker",
    picks: {}, note: "", scroll: 0, pending: false, error: null,
  };
}

const wrap = (n: number, len: number): number => (len <= 0 ? 0 : ((n % len) + len) % len);

export function reduceProjectCard(
  card: ProjectCardState | null,
  action: ProjectCardAction,
): ProjectCardState | null {
  switch (action.type) {
    case "project_card_shown": {
      const full = action.full ?? (card !== null && card.sessionId === action.sessionId && card.full);
      // Nothing waits on the person: the card goes, unless `/plan` asked to look.
      if (action.view.gate.kind === "none" && !full) return null;
      // The same gate at the same version (a repeated event): keep the person's place.
      if (
        card !== null &&
        card.sessionId === action.sessionId &&
        card.view.version === action.view.version &&
        card.view.gate.kind === action.view.gate.kind &&
        !card.pending
      ) {
        return { ...card, view: action.view, full };
      }
      return fresh(action.sessionId, action.view, full);
    }
    case "project_card_closed":
      return null;
    default:
      break;
  }
  if (card === null) return null;
  switch (action.type) {
    case "project_card_cursor_moved":
      return { ...card, cursor: wrap(card.cursor + action.delta, projectCardActions(card.view).length) };
    case "project_card_mode_set":
      if (action.mode === "edit" && card.view.rows.length === 0) return card;
      return { ...card, mode: action.mode, error: null, ...(action.mode === "actions" ? { picks: {}, note: "" } : {}) };
    case "project_card_row_moved":
      return { ...card, row: wrap(card.row + action.delta, card.view.rows.length) };
    case "project_card_field_toggled":
      return { ...card, field: card.field === "worker" ? "reviewer" : "worker" };
    case "project_card_pick_cycled": {
      const r = card.view.rows[card.row];
      if (r === undefined) return card;
      const options = projectFieldOptions(card.view, card.row, card.field);
      if (options.length === 0) return card;
      const current = options.indexOf(projectFieldValue(card, card.row, card.field));
      const next = options[wrap((current < 0 ? 0 : current) + action.delta, options.length)] ?? null;
      const prev = card.picks[r.taskId] ?? {};
      const pick: ProjectCardPick = card.field === "worker"
        ? { ...prev, worker: next ?? r.worker }
        : { ...prev, reviewer: next };
      return { ...card, picks: { ...card.picks, [r.taskId]: pick }, error: null };
    }
    case "project_card_note_set":
      return { ...card, note: action.note };
    case "project_card_scrolled":
      return { ...card, scroll: Math.max(0, card.scroll + action.delta) };
    case "project_card_pending":
      return { ...card, pending: true, error: null };
    case "project_card_failed":
      return { ...card, pending: false, error: action.error };
  }
}
