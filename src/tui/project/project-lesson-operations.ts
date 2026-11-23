import { projectDecisionOriginRefusal } from "../../sandbox/project-decision-origin.js";
import { isIncognitoSession } from "../../session/incognito.js";
import { stateDirProjectRecords, type ProjectLessonCall } from "../../session/project-decisions.js";
import {
  prepareProjectLessonDecision,
  projectLessonStatus,
  readProjectLessons,
  writeProjectLessonDecision,
  type ProjectLesson,
  type ProjectLessonProblem,
} from "../../session/project-lessons.js";
import { readProjectRef } from "../../session/session-project-store.js";
import type { SessionState } from "../../session/session-state.js";

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

export const PROJECT_LESSON_TURN_RUNNING = "A turn is running. Wait for it to finish, then decide.";

export function projectLessonPanel(
  session: SessionState,
  stateDir: string,
  isBusy: (folder: string, id: string) => boolean,
  choice?: ProjectLessonChoice,
): { panel: ProjectLessonPanel; notice?: string } {
  const unavailable = (blocked: string) => ({ panel: { rows: [], problems: [], blocked } });
  if (isIncognitoSession(session)) return unavailable("Project lessons are unavailable in incognito chats.");
  const ref = readProjectRef(session);
  if (!ref) return unavailable("Open the project in a regular chat before deciding a lesson.");
  const records = stateDirProjectRecords(stateDir);
  const read = records.read(ref.folder);
  if (!read.ok) return unavailable(read.problem.message);
  const record = read.record;
  if (record?.id !== ref.id) return unavailable("This chat has no matching project decision record.");

  const { lessons, problems } = readProjectLessons(record.folder);
  const calls = { ...record.lessonCalls };
  const blocked = projectDecisionOriginRefusal() ??
    (isBusy(record.folder, record.id) ? PROJECT_LESSON_TURN_RUNNING : undefined);
  const current = new Map(lessons.map(lesson => [lesson.id, lesson]));
  const result = (notice?: string) => {
    const rows: ProjectLessonRow[] = lessons.map(lesson => {
      const { id, hash } = lesson;
      const call = Object.hasOwn(calls, id) ? calls[id] : undefined;
      return { id, hash, lesson, status: projectLessonStatus(lesson, call), hasChoice: call !== undefined };
    });
    for (const [id, call] of Object.entries(calls)) {
      if (!current.has(id)) rows.push({ id, hash: call.hash, orphanedChoice: call.state });
    }
    return { panel: { rows, problems, blocked }, notice };
  };
  if (!choice || blocked) return result();

  const { id, hash, state, orphaned } = choice;
  const lesson = current.get(id);
  const previous = Object.hasOwn(calls, id) ? calls[id] : undefined;
  const matches = orphaned
    ? lesson === undefined && state === null && previous?.hash === hash
    : lesson?.hash === hash;
  if (!matches) return result("The lesson has changed. Read it again before deciding.");
  const prepared = prepareProjectLessonDecision(id, state, lesson, previous);
  if (!prepared.ok) return result(prepared.message);
  const { call } = prepared.decision;
  if (call === null && previous === undefined) return result("No choice to reopen.");
  const written = writeProjectLessonDecision(records, record, prepared.decision);
  if (!written.ok) return result(written.problem.message);
  if (call === null) delete calls[id];
  else calls[id] = call;
  const verb = state === "approved" ? "Approved" : state === "retired" ? "Retired" : "Reopened";
  return result(`${verb} ${id}.`);
}
