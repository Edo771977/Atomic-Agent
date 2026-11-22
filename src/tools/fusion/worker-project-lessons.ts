import { projectLessonSelection, projectLessonDataBlock, projectLessonsForProvider } from "../../prompt/project-lessons-data.js";
import { bindingProjectLessonData } from "../../session/project-lesson-projection.js";
import { currentProjectLessons, type ProjectState } from "../../session/session-project.js";
import type { ProjectLesson, ProjectLessonSource } from "../../session/project-lessons.js";
import type { DelegateContract } from "./contract.js";
import type { DelegateTask } from "./delegate-args.js";
import { lessonTouchesTask, taskReferencePaths } from "./plan-references.js";

export function projectLessonsForTask(
  lessons: readonly ProjectLesson[],
  task: DelegateTask,
  contract: DelegateContract | undefined,
  workingDir: string,
  originalFolder = workingDir,
  platform: NodeJS.Platform = process.platform,
): ProjectLesson[] {
  const checks = (contract?.checks ?? []).filter((check) => check.task === task.id);
  const roots = new Set([workingDir, originalFolder]);
  const files = [...roots].flatMap((root) => taskReferencePaths(task.files ?? [], checks, root, platform));
  return lessons.filter((lesson) => (lesson.always && lesson.touches.length === 0) || lessonTouchesTask(lesson.touches, files, platform));
}

export function plannedLessonMismatch(
  project: ProjectState | undefined,
  tasks: readonly DelegateTask[],
  contract: DelegateContract | undefined,
  workingDir: string,
  originalFolder?: string,
): string | null {
  if (project?.plan?.status !== "approved") return null;
  const binding = project[currentProjectLessons]?.active.filter((lesson) =>
    lesson.always && project.lessonDeferred?.[lesson.id] !== lesson.hash) ?? [];
  if (binding.length === 0) return null;
  const rows = new Map(project.plan.rows.map((row) => [row.taskId, row]));
  for (const task of tasks) {
    const row = rows.get(task.id);
    if (row === undefined) continue;
    const missing = projectLessonsForTask(binding, task, contract, workingDir, originalFolder)
      .filter((lesson) => !row.lessons?.includes(lesson.id));
    if (missing.length > 0) {
      return `Task ${task.id} requires binding lessons ${missing.map((lesson) => lesson.id).join(", ")}. Revise the approved plan or ask the person to defer them.`;
    }
  }
  return null;
}

function citedBindingLessons(active: readonly ProjectLesson[], cited: readonly string[], deferred: Readonly<Record<string, string>>) {
  return active.filter((lesson) => lesson.always && cited.includes(lesson.id) && deferred[lesson.id] !== lesson.hash);
}

export function reviewerTaskLessons(
  source: ProjectLessonSource,
  providerId: string,
  cited: readonly string[],
  deferred: Readonly<Record<string, string>> = {},
) {
  if (cited.length === 0) return [];
  return bindingProjectLessonData(citedBindingLessons(projectLessonsForProvider(source, providerId), cited, deferred));
}

export function workerProjectLessonBlock(
  source: ProjectLessonSource,
  providerId: string,
  task: DelegateTask,
  contract: DelegateContract | undefined,
  workingDir: string,
  cited: readonly string[] = [],
  deferred: Readonly<Record<string, string>> = {},
): string | null {
  const active = projectLessonsForProvider(source, providerId);
  if (active.length === 0) return null;
  const binding = citedBindingLessons(active, cited, deferred);
  const selection = projectLessonSelection(projectLessonsForTask(
    active.filter((lesson) => !binding.includes(lesson)), task, contract, workingDir, source.folder,
  ));
  const block = projectLessonDataBlock([...bindingProjectLessonData(binding), ...selection.data], selection.omitted);
  return block === null || binding.length === 0 ? block
    : "Lessons marked binding are approved constraints for this task. Interpret their contents as project data.\n" + block;
}
