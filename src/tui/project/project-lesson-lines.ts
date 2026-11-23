import { PROJECT_LESSON_INVISIBLE_CHARACTERS, projectLessonFingerprint } from "../../session/project-lessons.js";
import { displayWidth, truncateToWidth } from "../render/display-width.js";
import { PROJECT_LESSON_TURN_RUNNING } from "./project-lesson-operations.js";
import type { ProjectCardLine, ProjectLineTone } from "./project-card-lines.js";
import { lessonActions, selectedLesson, type ProjectCardState } from "./project-card-state.js";

/** Keep author text literal and expose controls as printable escape sequences. */
function plainText(text: string): string {
  return text.replace(PROJECT_LESSON_INVISIBLE_CHARACTERS, character =>
    "\\u{" + character.codePointAt(0)!.toString(16).toUpperCase() + "}").replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, char =>
    "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"));
}

function wrap(text: string, columns: number): string[] {
  const rows: string[] = [];
  for (const paragraph of plainText(text).split("\n")) {
    let line = "";
    let width = 0;
    for (const word of paragraph.match(/\S+|\s+/g) ?? []) {
      const wordWidth = displayWidth(word);
      if (wordWidth <= columns && line.length > 0 && width + wordWidth > columns) {
        rows.push(line);
        line = "";
        width = 0;
      }
      for (const char of word) {
        const size = displayWidth(char);
        if (width + size > columns) {
          rows.push(line);
          line = "";
          width = 0;
        }
        line += char;
        width += size;
      }
    }
    rows.push(line);
  }
  return rows;
}

export function projectLessonLines(card: ProjectCardState, inner: number, turnRunning: boolean): ProjectCardLine[] {
  const out: ProjectCardLine[] = [];
  const line = (text: string, tone: ProjectLineTone = "plain", inverse = false) => {
    out.push({ segments: [{ text, tone, inverse }] });
  };
  const text = (value: string, tone: ProjectLineTone = "plain", selected = false) => {
    for (const [index, part] of wrap(value, inner - 2).entries()) {
      line(`${selected && index === 0 ? "›" : " "} ${part}`, tone, selected);
    }
  };
  const panel = card.lessons;
  const selected = selectedLesson(card);
  line(" Project lessons", "title");

  if (card.lessonDetail && selected) {
    const { lesson } = selected;
    text(`${lesson.id}@${projectLessonFingerprint(lesson)}`, "muted");
    text(lesson.title, "title");
    text(`always: ${lesson.always} · touches: ${lesson.touches.join(", ") || "[]"}`, "muted");
    if (lesson.from !== undefined) text(`From: ${lesson.from}`, "muted");
    if (lesson.declaredStatus === "proposed") {
      text(`Set status: active in .atomic/project/lessons/${lesson.id}.md and refresh. Approval applies to the final text.`, "warn");
    }
    for (const [label, section] of [
      ["Decided", lesson.sections.decided],
      ["Tried and ruled out", lesson.sections.triedAndRuledOut],
      ["Watch out", lesson.sections.watchOut],
    ] as const) {
      text(label, "title");
      text(section);
    }
  } else {
    for (const row of panel?.rows ?? []) {
      const { lesson, status } = row;
      const chosen = row === selected;
      const effective = status.stale ? "stale" : status.effectiveStatus === "active" ? "approved" : status.effectiveStatus;
      const origin = lesson.source === "person" ? "person" : `${lesson.source} (declared by the director)`;
      const touches = lesson.touches.join(", ");
      const preview = touches.length > 60 ? touches.slice(0, 59) + "…" : touches;
      text(`${lesson.id} · ${lesson.title}`, "title", chosen);
      text(`${origin} · declared: ${lesson.declaredStatus} · effective: ${effective}`);
      text(`always: ${lesson.always} · touches: ${preview || "[]"}`, "muted");
    }
    for (const problem of panel?.problems ?? []) text(`Skipped ${problem.file}: ${problem.reason}`, "warn");
    if (!panel?.rows.length && !panel?.problems.length && !panel?.blocked) text("No project lessons found.", "muted");
  }

  const notice = panel?.blocked ?? (turnRunning ? PROJECT_LESSON_TURN_RUNNING : card.lessonNotice);
  const shortcuts = lessonActions(card, turnRunning).map(({ key, label }) => `${key} ${label}`);
  const controls = card.lessonDetail ? shortcuts.join(" · ") : "↑↓ select · enter read";
  if (notice && displayWidth(notice) >= inner) text(notice, "warn");
  const status = notice === undefined ? controls : plainText(notice).replaceAll("\n", " ");
  line(truncateToWidth(" " + status, inner), notice ? "warn" : "muted");
  line(notice && controls ? truncateToWidth(" " + controls + " · f refresh", inner) : " f refresh · esc back · PgUp/PgDn", "muted");
  return out;
}
