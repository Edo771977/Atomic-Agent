import { posix } from "node:path";

import { projectLessonData, projectLessonDataBlock, projectLessonsForProvider } from "../../prompt/project-lessons-data.js";
import type { ProjectLesson, ProjectLessonSource } from "../../session/project-lessons.js";
import type { DelegateContract } from "./contract.js";
import type { DelegateTask } from "./delegate-args.js";
import { taskReferencePaths } from "./plan-references.js";

export function projectLessonsForTask(
  lessons: readonly ProjectLesson[],
  task: DelegateTask,
  contract: DelegateContract | undefined,
  workingDir: string,
): ProjectLesson[] {
  const checks = (contract?.checks ?? []).filter((check) => check.task === task.id);
  const fold = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
  const files = taskReferencePaths(task.files ?? [], checks, workingDir).map(fold);
  return lessons.filter((lesson) => lesson.touches.some((touch) => {
    const path = fold(posix.normalize(touch.replaceAll("\\", "/")).replace(/\/$/, ""));
    return files.some((file) => path === "." || file === path || file.startsWith(path + "/"));
  }));
}

export function workerProjectLessonBlock(
  source: ProjectLessonSource,
  providerId: string,
  task: DelegateTask,
  contract: DelegateContract | undefined,
  workingDir: string,
): string | null {
  const active = projectLessonsForProvider(source, providerId);
  if (active.length === 0) return null;
  return projectLessonDataBlock(projectLessonData(projectLessonsForTask(active, task, contract, workingDir)));
}
