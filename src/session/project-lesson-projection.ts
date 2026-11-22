import { createHash } from "node:crypto";

import type { ProjectLesson } from "./project-lessons.js";
import { PROJECT_LIMITS } from "./project-limits.js";

export type ProjectLessonData = Pick<ProjectLesson, "id" | "title" | "always" | "sections"> & { binding?: true };

const MAX_LESSONS = 12;
const MAX_SECTION_CHARS = 300;
// Includes JSON escaping and leaves room for the frame and the omission notice.
const MAX_LESSON_JSON_CHARS = 7000;
// Every cited binding lesson gets a share, even when the advisory preview fills up.
const MAX_BINDING_JSON_CHARS = 32768;

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit - 1) + "…";
}

function projectLessonData(lesson: ProjectLesson, titleLimit: number, sectionLimit: number): ProjectLessonData {
  const { id, title, always, sections } = lesson;
  return {
    id, title: clip(title, titleLimit), always,
    sections: {
      decided: clip(sections.decided, sectionLimit),
      triedAndRuledOut: clip(sections.triedAndRuledOut, sectionLimit),
      watchOut: clip(sections.watchOut, sectionLimit),
    },
  };
}

export function projectLessonSelection(lessons: readonly ProjectLesson[]) {
  const data: ProjectLessonData[] = [];
  const included: Pick<ProjectLesson, "id" | "hash">[] = [];
  let chars = 0;
  for (const lesson of [...lessons].sort((a, b) => Number(b.always) - Number(a.always))) {
    if (data.length === MAX_LESSONS) break;
    const entry = projectLessonData(lesson, PROJECT_LIMITS.title, MAX_SECTION_CHARS);
    // The reviewer nests these entries inside pretty-printed JSON.
    const size = JSON.stringify(entry, null, 3).length + 16;
    if (chars + size > MAX_LESSON_JSON_CHARS) break;
    data.push(entry);
    included.push({ id: lesson.id, hash: lesson.hash });
    chars += size;
  }
  return { data, included, omitted: lessons.length - data.length };
}

export function bindingProjectLessonData(lessons: readonly ProjectLesson[]): ProjectLessonData[] {
  const share = Math.floor(MAX_BINDING_JSON_CHARS / lessons.length) - 1;
  return lessons.map((lesson) => {
    let limit = MAX_SECTION_CHARS;
    while (true) {
      const entry: ProjectLessonData = {
        ...projectLessonData(lesson, Math.min(limit, PROJECT_LIMITS.title), limit),
        binding: true,
      };
      if (JSON.stringify(entry).length <= share || limit <= 1) return entry;
      limit = Math.floor(limit / 2);
    }
  });
}

export function lessonsForCurrentPlan(lessons: readonly ProjectLesson[], deferred: Readonly<Record<string, string>> = {}): ProjectLesson[] {
  return lessons.filter((lesson) => !lesson.always || deferred[lesson.id] !== lesson.hash);
}

export function projectLessonOmissionNotice(omitted: number): string {
  return `${omitted} more lessons were not shown.`;
}

export function projectLessonReviewSelection(active: readonly ProjectLesson[], allowed: boolean) {
  const selection = projectLessonSelection(allowed ? active : []);
  const notice = !allowed && active.length > 0
    ? "Active lessons were not supplied by the folder policy."
    : selection.omitted > 0 ? projectLessonOmissionNotice(selection.omitted) : undefined;
  const sorted = [...selection.included].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const basis = createHash("sha256").update(JSON.stringify([sorted, notice ?? null])).digest("hex").slice(0, 16);
  return { ...selection, notice, basis };
}
