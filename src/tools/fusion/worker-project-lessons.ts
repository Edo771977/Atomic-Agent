import { posix } from "node:path";

import { projectLessonSelection, projectLessonDataBlock, projectLessonsForProvider } from "../../prompt/project-lessons-data.js";
import type { ProjectLesson, ProjectLessonSource } from "../../session/project-lessons.js";
import type { DelegateContract } from "./contract.js";
import type { DelegateTask } from "./delegate-args.js";
import { taskReferencePaths } from "./plan-references.js";

export function projectLessonsForTask(
  lessons: readonly ProjectLesson[],
  task: DelegateTask,
  contract: DelegateContract | undefined,
  workingDir: string,
  originalFolder = workingDir,
  platform: NodeJS.Platform = process.platform,
): ProjectLesson[] {
  const checks = (contract?.checks ?? []).filter((check) => check.task === task.id);
  const fold = (path: string) => platform === "win32" || platform === "darwin" ? path.toLowerCase() : path;
  const roots = new Set([workingDir, originalFolder]);
  const files = [...roots].flatMap((root) => taskReferencePaths(task.files ?? [], checks, root, platform)).map(fold);
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
  const selection = projectLessonSelection(projectLessonsForTask(active, task, contract, workingDir, source.folder));
  return projectLessonDataBlock(selection.data, selection.omitted);
}
