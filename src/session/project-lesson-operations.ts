import { isIncognitoSession } from "./incognito.js";
import { stateDirProjectRecords, type ProjectLessonCall } from "./project-decisions.js";
import {
  prepareProjectLessonDecision,
  projectLessonStatus,
  readProjectLessons,
  writeProjectLessonDecision,
  type ProjectLesson,
  type ProjectLessonProblem,
} from "./project-lessons.js";
import { projectFolderOf, sameProjectFolder } from "./project-folder.js";
import { PROJECT_LESSON_TURN_RUNNING } from "./project-lesson-text.js";
import { readProjectRef } from "./session-project-store.js";
import type { SessionState } from "./session-state.js";

export interface ProjectLessonChoice {
  id: string;
  hash: string;
  state: ProjectLessonCall["state"] | null;
  orphaned?: true;
}

export type ProjectLessonRow = Pick<ProjectLesson, "id" | "hash"> & (
  | { lesson: ProjectLesson; status: ReturnType<typeof projectLessonStatus>; hasChoice: boolean }
  | { lesson?: undefined; orphanedChoice: ProjectLessonCall["state"] }
);

export interface ProjectLessonPanel {
  rows: ProjectLessonRow[];
  problems: ProjectLessonProblem[];
  blocked?: string;
}

type LessonError = "incognito" | "no-project" | "turn-running" | "stale-view" | "invalid";

export function projectLessonPanel(
  session: SessionState,
  stateDir: string,
  isBusy: (folder: string, id: string) => boolean,
  choice?: ProjectLessonChoice,
  originRefusal?: () => string | undefined,
): { panel: ProjectLessonPanel; notice?: string; code?: LessonError } {
  const unavailable = (blocked: string, code: LessonError = "no-project") => ({ panel: { rows: [], problems: [], blocked }, code });
  if (isIncognitoSession(session)) return unavailable("Project lessons are unavailable in incognito chats.", "incognito");
  const ref = readProjectRef(session);
  if (!ref) return unavailable("Lessons require a chat bound to a saved project.");
  if (session.projectProblem !== undefined || !sameProjectFolder(ref.folder, projectFolderOf(session))) {
    return unavailable("This chat's project is unavailable.");
  }
  const records = stateDirProjectRecords(stateDir);
  const read = records.read(ref.folder);
  if (!read.ok) return unavailable(read.problem.message);
  const record = read.record;
  if (record?.id !== ref.id) return unavailable("This chat has no matching project decision record.");

  const { lessons, problems } = readProjectLessons(ref.folder);
  const calls = { ...record.lessonCalls };
  const origin = originRefusal?.();
  const busy = isBusy(ref.folder, ref.id);
  const blocked = origin ?? (busy ? PROJECT_LESSON_TURN_RUNNING : undefined);
  const current = new Map(lessons.map(lesson => [lesson.id, lesson]));
  const result = (notice?: string, code?: LessonError) => {
    const rows: ProjectLessonRow[] = lessons.map(lesson => {
      const { id, hash } = lesson;
      const call = Object.hasOwn(calls, id) ? calls[id] : undefined;
      return { id, hash, lesson, status: projectLessonStatus(lesson, call), hasChoice: call !== undefined };
    });
    for (const [id, call] of Object.entries(calls)) {
      if (!current.has(id)) rows.push({ id, hash: call.hash, orphanedChoice: call.state });
    }
    return { panel: { rows, problems, blocked }, notice, code };
  };
  if (!choice || blocked) return result(undefined, busy ? "turn-running" : undefined);

  const { id, hash, state, orphaned } = choice;
  const lesson = current.get(id);
  const previous = Object.hasOwn(calls, id) ? calls[id] : undefined;
  const matches = orphaned
    ? lesson === undefined && state === null && previous?.hash === hash
    : lesson?.hash === hash;
  if (!matches) return result("The lesson has changed. Read it again before deciding.", "stale-view");
  const prepared = prepareProjectLessonDecision(id, state, lesson, previous);
  if (!prepared.ok) return result(prepared.message, "invalid");
  const { call } = prepared.decision;
  if (call === null && previous === undefined) return result("No choice to reopen.", "invalid");
  const written = writeProjectLessonDecision(records, record, prepared.decision);
  if (!written.ok) return result(written.problem.message, "stale-view");
  if (call === null) delete calls[id];
  else calls[id] = call;
  const verb = state === "approved" ? "Approved" : state === "retired" ? "Retired" : "Reopened";
  return result(`${verb} ${id}.`);
}
