import type { ProjectLesson } from "./project-lessons.js";
import { PROJECT_LIMITS } from "./project-limits.js";

export type ProjectLessonData = Pick<ProjectLesson, "id" | "title" | "always" | "sections">;

const MAX_LESSONS = 12;
const MAX_SECTION_CHARS = 300;
// Includes JSON escaping and leaves room for the frame and the omission notice.
const MAX_LESSON_JSON_CHARS = 7000;

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit - 1) + "…";
}

export function projectLessonSelection(lessons: readonly ProjectLesson[]) {
  const data: ProjectLessonData[] = [];
  const included: Pick<ProjectLesson, "id" | "hash">[] = [];
  let chars = 0;
  for (const { id, title, always, sections, hash } of [...lessons].sort((a, b) => Number(b.always) - Number(a.always))) {
    if (data.length === MAX_LESSONS) break;
    const entry = {
      id, title: clip(title, PROJECT_LIMITS.title), always,
      sections: {
        decided: clip(sections.decided, MAX_SECTION_CHARS),
        triedAndRuledOut: clip(sections.triedAndRuledOut, MAX_SECTION_CHARS),
        watchOut: clip(sections.watchOut, MAX_SECTION_CHARS),
      },
    };
    // The reviewer nests these entries inside pretty-printed JSON.
    const size = JSON.stringify(entry, null, 3).length + 16;
    if (chars + size > MAX_LESSON_JSON_CHARS) break;
    data.push(entry);
    included.push({ id, hash });
    chars += size;
  }
  return { data, included, omitted: lessons.length - data.length };
}
