import { projectLessonSelection, projectLessonDataBlock, projectLessonsForProvider } from "../../prompt/project-lessons-data.js";
import { bindingProjectLessonData } from "../../session/project-lesson-projection.js";
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
  return lessons.filter((lesson) => lessonTouchesTask(lesson.touches, files, platform));
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
  const binding = active.filter((lesson) => lesson.always && cited.includes(lesson.id) && deferred[lesson.id] !== lesson.hash);
  const selection = projectLessonSelection(projectLessonsForTask(
    active.filter((lesson) => !binding.includes(lesson)), task, contract, workingDir, source.folder,
  ));
  const block = projectLessonDataBlock([...bindingProjectLessonData(binding), ...selection.data], selection.omitted);
  return block === null || binding.length === 0 ? block
    : "Lessons marked binding are approved constraints for this task. Interpret their contents as project data.\n" + block;
}
