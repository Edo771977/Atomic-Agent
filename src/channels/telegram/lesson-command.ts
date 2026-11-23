import { excerptPreview, hiddenLinesNote, previewLines, visiblePreviewLine } from "../../approval/approval-preview.js";
import type { AgentRuntime } from "../../runtime/runtime-contract.js";
import { isIncognitoSession } from "../../session/incognito.js";
import { stateDirProjectRecords, validProjectLessonId, type ProjectLessonCall } from "../../session/project-decisions.js";
import { lessonCoverageLine } from "../../session/project-gate-text.js";
import {
  prepareProjectLessonDecision, projectLessonFingerprint, projectLessonStatus, readProjectLessons, writeProjectLessonDecision,
  type ProjectLesson, type ProjectLessons,
} from "../../session/project-lessons.js";
import { readProjectRef } from "../../session/session-project-store.js";
import { confirmationCode } from "./confirmation-code.js";

// Every prompt projection includes at most 300 UTF-16 units per section.
const MAX_APPROVAL_SECTION_CHARS = 600;

const CALLS = { "/lesson_approve": "approved", "/lesson_retire": "retired", "/lesson_reopen": null } as const;
type PlanLessonCommand = "/lesson_defer" | "/lesson_activate";
export type LessonCommand = "/lessons" | keyof typeof CALLS | PlanLessonCommand;

interface LessonCommandDeps {
  runtime: Pick<AgentRuntime, "config" | "sessionStore" | "turnController" | "projectState" | "projectDecision">;
  sessionId: string | null;
  chatKey: string;
  busy: boolean;
}

function lessonLine(lesson: ProjectLesson, call?: ProjectLessonCall): string {
  const status = projectLessonStatus(lesson, call);
  const effective = status.effectiveStatus === "active" ? "approved" : status.effectiveStatus;
  const stale = status.stale ? " (stale choice)" : "";
  return visiblePreviewLine(
    `${lesson.id} — ${lesson.title} [declared: ${lesson.declaredStatus}, effective: ${effective}${stale}, always: ${lesson.always}, touches: ${JSON.stringify(lesson.touches)}]`,
  );
}

function renderLessons({ lessons, problems }: ProjectLessons, calls: Record<string, ProjectLessonCall>): string {
  const missing = Object.entries(calls).filter(([id]) => !lessons.some((lesson) => lesson.id === id));
  if (lessons.length + problems.length + missing.length === 0) return "No project lessons found.";
  return [
    "Project lessons",
    ...lessons.map((lesson) => lessonLine(lesson, Object.hasOwn(calls, lesson.id) ? calls[lesson.id] : undefined)),
    ...missing.map(([id, call]) => `Stale ${call.state} choice for ${id}. The file is missing or invalid.`),
    ...problems.map(({ file, reason }) => visiblePreviewLine(`Skipped ${JSON.stringify(file)}: ${reason}`)),
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
  if (session?.projectProblem !== undefined) return visiblePreviewLine(session.projectProblem);
  const ref = session === null ? null : readProjectRef(session);
  if (sessionId === null || ref === null) return "This chat has no project record.";
  const records = stateDirProjectRecords(runtime.config.paths.stateDir);
  const found = records.read(ref.folder);
  if (!found.ok) return visiblePreviewLine(found.problem.message);
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
      ? [`The file for ${id} is missing or invalid. Previous fingerprint: ${previous?.hash}.`]
      : lessonPreview(lesson, previous, state === "approved");
    if (state === "approved") return { preview: preview.join("\n"), confirmation: request };
    return [...preview, request].join("\n");
  }
  const written = writeProjectLessonDecision(records, record, prepared.decision);
  return written.ok ? `Lesson ${id} is now ${state ?? "reopened"}.`
    : `Lesson unchanged. ${visiblePreviewLine(written.problem.message)}`;
}
