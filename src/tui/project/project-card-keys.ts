import type { Key } from "ink";

import type { AppKeyContext } from "../app-key-bindings.js";
import { MAX_PROJECT_NOTE_CHARS } from "../../session/project-decision-parse.js";
import type { ProjectDecision, ProjectVerdict } from "../../session/session-project.js";
import {
  lessonActions,
  selectedLesson,
  projectBacklogActions,
  projectCardActions,
  projectEditRows,
  type ProjectCardState,
} from "./project-card-state.js";

type ProjectCardKeyContext = Pick<AppKeyContext, "dispatch" | "callbacks">;

/** Lines PgUp/PgDn move the card by. */
const SCROLL_STEP = 5;

/**
 * Keys of the project card (issue #39). Modal while the card is up: it
 * owns every key but Ctrl+C (the caller lets that through). Esc steps
 * back (edit/note → buttons) or puts the card away; `/plan` brings it
 * back. Decisions go out through `callbacks.onProjectDecision`; the card
 * waits (`pending`) until the orchestrator shows the runtime's answer.
 */
export function handleProjectCardKey(
  input: string,
  key: Key,
  card: ProjectCardState,
  ctx: ProjectCardKeyContext,
  turnRunning = false,
): void {
  const { dispatch, callbacks } = ctx;
  if (key.pageDown || key.pageUp) {
    dispatch({ type: "project_card_scrolled", delta: key.pageDown ? SCROLL_STEP : -SCROLL_STEP });
    return;
  }
  if (key.escape) {
    if (card.mode === "lessons" && card.lessonDetail) dispatch({ type: "project_card_lesson_detail", open: false });
    else if (card.mode === "lessons" || (card.mode !== "actions" && !card.pending)) dispatch({ type: "project_card_mode_set", mode: "actions" });
    else dispatch({ type: "project_card_closed" });
    return;
  }
  if (card.pending) return;

  const send = (decision: ProjectDecision): void => {
    dispatch({ type: "project_card_pending" });
    callbacks.onProjectDecision?.(card.sessionId, decision);
  };
  const letter = !key.ctrl && !key.meta ? input.toLowerCase() : "";
  if (card.mode === "actions" && letter === "v") {
    callbacks.onProjectLessons?.(card.sessionId);
    return;
  }
  if (card.mode === "lessons") {
    if (letter === "f") callbacks.onProjectLessons?.(card.sessionId);
    const selected = selectedLesson(card);
    if (!card.lessonDetail) {
      if (key.upArrow || key.downArrow) dispatch({ type: "project_card_lesson_moved", delta: key.downArrow ? 1 : -1 });
      if (key.return && selected) dispatch({ type: "project_card_lesson_detail", open: true });
      return;
    }
    const action = lessonActions(card, turnRunning).find(entry => entry.key === letter);
    if (selected && action) {
      const { id, hash, lesson } = selected;
      callbacks.onProjectLessons?.(card.sessionId, { id, hash, state: action.state, ...(lesson ? {} : { orphaned: true }) });
    }
    return;
  }
  if (card.mode === "actions" && letter === "b") {
    dispatch({ type: "project_card_mode_set", mode: "backlog" });
    return;
  }
  if (card.mode === "backlog") {
    if (key.upArrow || key.downArrow) {
      dispatch({ type: "project_card_backlog_moved", delta: key.downArrow ? 1 : -1 });
      return;
    }
    const action = projectBacklogActions(card).find(entry => entry.key === letter);
    const id = card.backlogId;
    if (!action || !id) return;
    if (!callbacks.onProjectBacklogDecision) {
      dispatch({ type: "project_card_failed", error: "This runtime cannot take backlog decisions." });
      return;
    }
    dispatch({ type: "project_card_pending" });
    callbacks.onProjectBacklogDecision(card.sessionId, { id, state: action.state });
    return;
  }
  const version = card.view.version;
  if (version === null) {
    // Nothing can be decided (no open gate): only Esc closes the card.
    return;
  }
  const base = { gate: card.view.gate, version };

  if (card.mode === "note") {
    if (key.return) {
      const note = card.note.trim();
      const overReview = card.noteFor === "approveOverReview";
      if (note.length === 0) {
        dispatch({ type: "project_card_failed", error: overReview ? "Type why you approve over the open review first." : "Type the correction first." });
        return;
      }
      send({ ...base, verdict: overReview ? "approveOverReview" : "edit", edits: { note } });
      return;
    }
    if (key.backspace || key.delete) {
      dispatch({ type: "project_card_note_set", note: card.note.slice(0, -1) });
      return;
    }
    if (input.length > 0 && !key.ctrl && !key.meta) {
      // A paste arrives as one chunk; line breaks fold to spaces.
      dispatch({ type: "project_card_note_set", note: (card.note + input.replace(/[\r\n]+/g, " ")).slice(0, MAX_PROJECT_NOTE_CHARS) });
    }
    return;
  }

  if (card.mode === "edit") {
    if (key.upArrow || key.downArrow) {
      dispatch({ type: "project_card_row_moved", delta: key.downArrow ? 1 : -1 });
    } else if (key.tab) {
      dispatch({ type: "project_card_field_toggled" });
    } else if (key.leftArrow || key.rightArrow) {
      dispatch({ type: "project_card_pick_cycled", delta: key.rightArrow ? 1 : -1 });
    } else if (key.return) {
      const rows = projectEditRows(card);
      if (rows.length === 0) {
        dispatch({ type: "project_card_failed", error: "Nothing changed: pick another worker or reviewer with ←/→ first." });
        return;
      }
      send({ ...base, verdict: "edit", edits: { rows } });
    }
    return;
  }

  const actions = projectCardActions(card.view);
  if (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow) {
    dispatch({ type: "project_card_cursor_moved", delta: key.rightArrow || key.downArrow ? 1 : -1 });
    return;
  }
  const picked = key.return
    ? actions[card.cursor]
    : !key.ctrl && !key.meta
      ? actions.find((a) => a.key === input.toLowerCase())
      : undefined;
  if (picked === undefined) return;
  if (picked.decisionStatus !== undefined) {
    // Issue #112: the person's call, recorded with the plan; the plan waits for approval again.
    send({ ...base, verdict: "edit", edits: { decisionStatus: picked.decisionStatus } });
    return;
  }
  if (picked.lessonStatus !== undefined) {
    send({ ...base, verdict: "edit", edits: { lessonStatus: picked.lessonStatus } });
    return;
  }
  run(picked.verdict);

  function run(verdict: ProjectVerdict): void {
    if (verdict === "approveOverReview") {
      // Issue #98: the person's reason goes with it.
      dispatch({ type: "project_card_mode_set", mode: "note", noteFor: "approveOverReview" });
      return;
    }
    if (verdict !== "edit") {
      send({ ...base, verdict });
      return;
    }
    switch (card.view.gate.kind) {
      case "plan":
        dispatch({ type: "project_card_mode_set", mode: "edit" });
        return;
      case "milestone":
        dispatch({ type: "project_card_mode_set", mode: "note" });
        return;
      default:
        // The brief: the person says what to change in the chat and the
        // director redrafts it (a new draft opens the gate again).
        dispatch({ type: "project_card_closed" });
        callbacks.onProjectReviseBrief?.();
    }
  }
}
