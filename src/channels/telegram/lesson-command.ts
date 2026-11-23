import { excerptPreview, hiddenLinesNote, previewLines, visiblePreviewLine } from "../../approval/approval-preview.js";
import type { AgentRuntime } from "../../runtime/runtime-contract.js";
import { isIncognitoSession } from "../../session/incognito.js";
import { stateDirProjectRecords, validProjectLessonId, type ProjectLessonCall } from "../../session/project-decisions.js";
import { projectFolderOf, sameProjectFolder } from "../../session/project-folder.js";
import { lessonCoverageLine } from "../../session/project-gate-text.js";
import {
  prepareProjectLessonDecision, projectLessonFingerprint, projectLessonStatus, readProjectLessons, writeProjectLessonDecision,
  type ProjectLesson, type ProjectLessons,
} from "../../session/project-lessons.js";
import { readProjectRef } from "../../session/session-project-store.js";
import { confirmationCode } from "./confirmation-code.js";

// Every prompt projection includes at most 300 UTF-16 units per section.
const MAX_APPROVAL_SECTION_CHARS = 600;

const MAX_LIST_LESSONS = 8;
const MAX_LIST_DIAGNOSTICS = 6;
const MAX_LIST_TOUCHES = 3;

const CALLS = { "/lesson_approve": "approved", "/lesson_retire": "retired", "/lesson_reopen": null } as const;
type PlanLessonCommand = "/lesson_defer" | "/lesson_activate";
export type LessonCommand = "/lessons" | keyof typeof CALLS | PlanLessonCommand;

interface LessonCommandDeps {
  runtime: Pick<AgentRuntime, "config" | "sessionStore" | "turnController" | "projectState" | "projectDecision">;
  sessionId: string | null;
  chatKey: string;
  busy: boolean;
}

function listExcerpt(text: string, maxChars: number): string {
  return excerptPreview(text, { maxLines: 1, maxChars }).lines[0] ?? "";
}

function lessonLine(lesson: ProjectLesson, call?: ProjectLessonCall, recordAvailable = true, compact = false): string {
  const status = projectLessonStatus(lesson, call);
  const effective = !recordAvailable ? "unknown" : status.effectiveStatus === "active" ? "approved" : status.effectiveStatus;
  const stale = status.stale ? " (stale choice)" : "";
  const title = compact ? listExcerpt(lesson.title, 160) : visiblePreviewLine(lesson.title);
  const shownTouches = compact ? lesson.touches.slice(0, MAX_LIST_TOUCHES) : lesson.touches;
  const touches = shownTouches.map((path) => {
    const quoted = JSON.stringify(path);
    return compact ? listExcerpt(quoted, 120) : visiblePreviewLine(quoted);
  }).join(", ");
  const more = lesson.touches.length - shownTouches.length;
  const omitted = more === 0 ? "" : `, +${more}`;
  return `${lesson.id} — ${title} [declared: ${lesson.declaredStatus}, effective: ${effective}${stale}, always: ${lesson.always}, touches: [${touches}${omitted}]]`;
}

function renderLessons({ lessons, problems }: ProjectLessons, calls: Record<string, ProjectLessonCall>, recordAvailable = true): string {
  const missing = Object.entries(calls).filter(([id]) => !lessons.some((lesson) => lesson.id === id));
  if (lessons.length + problems.length + missing.length === 0) return "No project lessons found.";
  const diagnostics = [
    ...missing.map(([id, call]) => `Stale ${call.state} choice for ${id}. The file is missing or invalid.`),
    ...problems.map(({ file, reason }) => `Skipped ${JSON.stringify(file)}: ${reason}`),
  ];
  const otherLessons = lessons.length - MAX_LIST_LESSONS;
  const otherDiagnostics = diagnostics.length - MAX_LIST_DIAGNOSTICS;
  return [
    "Project lessons",
    ...lessons.slice(0, MAX_LIST_LESSONS).map((lesson) =>
      lessonLine(lesson, Object.hasOwn(calls, lesson.id) ? calls[lesson.id] : undefined, recordAvailable, true)),
    ...(otherLessons > 0 ? [`+${otherLessons} lessons: use the CLI for the full list.`] : []),
    ...diagnostics.slice(0, MAX_LIST_DIAGNOSTICS).map((line) => listExcerpt(line, 240)),
    ...(otherDiagnostics > 0 ? [`+${otherDiagnostics} diagnostics: use the CLI for the full list.`] : []),
    "Use /lesson_approve, /lesson_retire or /lesson_reopen with a lesson ID to preview a choice.",
  ].join("\n");
}

function lessonPreview(lesson: ProjectLesson, previous: ProjectLessonCall | undefined, full: boolean): string[] {
  const sections = [
    ["Decided", lesson.sections.decided],
    ["Tried and ruled out", lesson.sections.triedAndRuledOut],
    ["Watch out", lesson.sections.watchOut],
  ] as const;
  return [
    lessonLine(lesson, previous),
    `Fingerprint: ${projectLessonFingerprint(lesson)}`,
    ...sections.flatMap(([title, text]) => {
      if (full) return [title + ":", ...previewLines(text).map((line) => "  " + line)];
      const excerpt = excerptPreview(text, { maxLines: 8, maxChars: 600 });
      const note = hiddenLinesNote(excerpt.hiddenLines, excerpt.cutChars);
      return [`${title}:`, ...excerpt.lines.map((line) => `  ${line}`), ...(note === null ? [] : [`  ${note}`])];
    }),
  ];
}

function runPlanLessonCommand(
  command: PlanLessonCommand,
  id: string,
  confirmation: string | undefined,
  lesson: ProjectLesson | undefined,
  basis: readonly unknown[],
  { runtime, sessionId }: LessonCommandDeps & { sessionId: string },
): string {
  const view = runtime.projectState?.(sessionId);
  if (!view || view.gate.kind !== "plan" || view.version === null || !view.allowedVerdicts.includes("edit")) {
    return "Change a binding lesson's status while a plan waits for your approval. Reply /plan to see the current gate.";
  }
  if (!runtime.projectDecision) return "This agent takes no project decisions.";
  const row = view.lessonCoverage?.find((entry) => entry.id === id);
  const code = confirmationCode([...basis, view.version, row]);
  if (confirmation !== undefined && confirmation !== code) {
    return `The plan or lesson has changed. Preview the decision again with ${command} ${id}.`;
  }
  if (row === undefined || lesson?.always !== true) {
    return `No binding lesson named ${id} in this plan. Reply /plan to see the binding lessons.`;
  }
  const status = command === "/lesson_defer" ? "deferred" : "active";
  if (row.deferred === (status === "deferred")) return `Lesson ${id} is already ${status} for this plan.`;
  if (confirmation === undefined) {
    return [
      `Plan v${view.version}. ${visiblePreviewLine(lessonCoverageLine(row))}`,
      `Set lesson ${id} to ${status} for this plan. To confirm, reply ${command} ${id} ${code}.`,
    ].join("\n");
  }
  const result = runtime.projectDecision(sessionId, {
    gate: view.gate, version: view.version, verdict: "edit", edits: { lessonStatus: { [id]: status } },
  });
  return result.ok ? `Lesson ${id} is now ${status} for this plan. Reply /plan to review it.`
    : result.error.code === "project-store"
      ? "Lesson unchanged. The project record is unavailable. Check it from the CLI."
      : `Lesson unchanged. ${visiblePreviewLine(result.error.message)}`;
}

/** The inbound handler enforces owner, chat and egress rules before calling this. */
export function runLessonCommand(
  command: LessonCommand,
  args: readonly string[],
  deps: LessonCommandDeps,
): string | { preview: string; confirmation: string } {
  const { runtime, sessionId, chatKey, busy } = deps;
  if (command === "/lessons" && args.length !== 0) return "Usage: /lessons";
  const session = sessionId === null ? null : runtime.sessionStore.load(sessionId);
  if (isIncognitoSession(session)) return "Project lessons are unavailable in incognito chats.";
  const ref = session === null ? null : readProjectRef(session);
  if (sessionId === null || session === null || ref === null ||
      !sameProjectFolder(ref.folder, projectFolderOf(session))) return "This chat has no project record.";
  const records = stateDirProjectRecords(runtime.config.paths.stateDir);
  const found = records.read(ref.folder);
  if (!found.ok) {
    if (command === "/lessons") {
      return ["Warning: the project record is unavailable. Approval status is unknown.",
        renderLessons(readProjectLessons(ref.folder), {}, false)].join("\n");
    }
    return "The project record is unavailable. Use the CLI to check it before deciding.";
  }
  if (session.projectProblem !== undefined) return "This chat's project is unavailable.";
  const record = found.record;
  if (record?.id !== ref.id) return "This chat has no project record.";
  if (command !== "/lessons" && (busy || runtime.turnController.isBusy(sessionId) ||
      runtime.sessionStore.liveProjectTurn(ref.folder, ref.id) !== null)) {
    return "Wait for the current turn to finish, then decide.";
  }

  const files = readProjectLessons(ref.folder);
  const calls = record.lessonCalls ?? {};
  if (command === "/lessons") return renderLessons(files, calls);
  const [id, confirmation] = args;
  if (id === undefined || !validProjectLessonId(id) || args.length > 2 ||
      (confirmation !== undefined && !/^[0-9a-f]{16}$/.test(confirmation))) {
    return `Usage: ${command} <id> [confirmation-code]. Reply /lessons to see the lesson IDs.`;
  }
  const lesson = files.lessons.find((candidate) => candidate.id === id);
  const previous = Object.hasOwn(calls, id) ? calls[id] : undefined;
  const basis = [chatKey, sessionId, ref.folder, ref.id, command, id, lesson?.hash, previous?.hash, previous?.state];
  if (command === "/lesson_defer" || command === "/lesson_activate") {
    return runPlanLessonCommand(command, id, confirmation, lesson, basis, { ...deps, sessionId });
  }
  const code = confirmationCode(basis);
  if (confirmation !== undefined && confirmation !== code) {
    return "The lesson has changed. Read it again and request a new preview.";
  }
  const state = CALLS[command];
  const prepared = prepareProjectLessonDecision(id, state, lesson, previous);
  if (!prepared.ok) return prepared.message;
  if (state === null && previous === undefined) return `No choice to reopen for ${id}.`;
  if (state === "approved" && lesson !== undefined &&
      Object.values(lesson.sections).some((text) => text.length > MAX_APPROVAL_SECTION_CHARS)) {
    return "A lesson section is too long to preview in full. Read the file and approve it from the CLI.";
  }
  if (confirmation === undefined) {
    const request = `To confirm ${command}, reply ${command} ${id} ${code}.`;
    const preview = lesson === undefined
      ? [`The file for ${id} is missing or invalid. Previous fingerprint: ${previous === undefined ? "unavailable" : projectLessonFingerprint(previous)}.`]
      : lessonPreview(lesson, previous, state === "approved");
    if (state === "approved") return { preview: preview.join("\n"), confirmation: request };
    return [...preview, request].join("\n");
  }
  const written = writeProjectLessonDecision(records, record, prepared.decision);
  return written.ok ? `Lesson ${id} is now ${state ?? "reopened"}.`
    : "Lesson unchanged. The project record could not be updated. Request a fresh preview or check the record from the CLI.";
}
