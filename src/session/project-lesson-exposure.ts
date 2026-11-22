import { AsyncLocalStorage } from "node:async_hooks";

import { macroTurnBoundaries } from "./conversation-turn.js";
import type { SessionState } from "./session-state.js";

const turn = new AsyncLocalStorage<{ exposed: boolean }>();

export function trackProjectLessonExposure<T>(run: () => T): T {
  return turn.run({ exposed: false }, run);
}

export function recordRestrictedProjectLessonExposure(): void {
  const state = turn.getStore();
  if (state !== undefined) state.exposed = true;
}

export function restrictedProjectLessonsExposed(): boolean {
  return turn.getStore()?.exposed === true;
}

/** Store only the exposure bit, on the transcript row that survives archiving and reload. */
export function rememberRestrictedProjectLessonExposure(state: SessionState, start: number): SessionState {
  const first = state.turns[start];
  if (!restrictedProjectLessonsExposed() || first === undefined || first.restrictedProjectLessonExposure === true) return state;
  const turns = [...state.turns];
  turns[start] = { ...first, restrictedProjectLessonExposure: true };
  return { ...state, turns };
}

/** The span can start partway through an exposed macro-turn. */
export function restrictedProjectLessonExposureInSpan(state: SessionState, from: number, through: number): boolean {
  if (from >= through) return false;
  let start = 0;
  for (const index of macroTurnBoundaries(state.turns, state.macroTurnStarts)) {
    if (index > from) break;
    start = index;
  }
  for (let i = start; i < through && i < state.turns.length; i += 1) {
    if (state.turns[i]?.restrictedProjectLessonExposure === true) return true;
  }
  return false;
}
