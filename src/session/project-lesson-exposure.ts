import { AsyncLocalStorage } from "node:async_hooks";

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
