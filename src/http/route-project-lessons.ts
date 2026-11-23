import { validProjectLessonId } from "../session/project-decisions.js";
import { projectLessonPanel, type ProjectLessonChoice } from "../session/project-lesson-operations.js";
import { PROJECT_LESSON_SECTION_LIMIT, projectLessonPromptEnds } from "../session/project-lesson-projection.js";
import { readProjectRef } from "../session/session-project-store.js";
import { openaiError } from "./openai-errors.js";
import { readJsonBody, sendError, sendJson, type HttpHandler } from "./request-context.js";
import { SERVE_RESTRICTED_CODE, SERVE_RESTRICTED_NOTICE, serveWithheld } from "./serve-egress.js";

const status = {
  "no-project": 404,
  "incognito": 409,
  "turn-running": 409,
  "stale-view": 409,
  "invalid": 400,
  "busy": 503,
  "io": 500,
} as const;

export const handleProjectLessons: HttpHandler = async (req, res, ctx) => {
  let sessionId: unknown = new URL(req.url ?? "/", "http://localhost").searchParams.get("session");
  let choice: ProjectLessonChoice | undefined;
  if (req.method === "POST") {
    if (ctx.apiKey === null) {
      return sendError(res, 403, openaiError(
        "Saving project lesson choices over HTTP requires atag serve with an API key.",
        "permission_error", null, "person-auth-required",
      ));
    }
    const body = await readJsonBody<Record<string, unknown> | null>(req).catch(() => null);
    const { session, lesson, action, fingerprint, orphaned } = body ?? {};
    if (typeof lesson !== "string" || !validProjectLessonId(lesson) ||
        typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint) ||
        (action !== "approve" && action !== "retire" && action !== "reopen") ||
        (orphaned !== undefined && (orphaned !== true || action !== "reopen"))) {
      return sendError(res, 400, openaiError("A lesson, action and full fingerprint are required."));
    }
    sessionId = session;
    choice = {
      id: lesson, hash: fingerprint,
      state: action === "approve" ? "approved" : action === "retire" ? "retired" : null,
      ...(orphaned === true ? { orphaned } : {}),
    };
  }
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return sendError(res, 400, openaiError("session is required"));
  }
  if (serveWithheld(ctx, sessionId)()) {
    return sendError(res, 403, openaiError(SERVE_RESTRICTED_NOTICE, "permission_error", null, SERVE_RESTRICTED_CODE));
  }
  const { runtime } = ctx;
  const session = runtime.sessionStore.load(sessionId);
  if (!session) return sendError(res, 404, openaiError("Unknown session."));
  const ref = readProjectRef(session);
  if (ref && serveWithheld(ctx, { id: session.id, workingDir: ref.folder, metadata: session.metadata })()) {
    return sendError(res, 403, openaiError(SERVE_RESTRICTED_NOTICE, "permission_error", null, SERVE_RESTRICTED_CODE));
  }
  const result = projectLessonPanel(session, runtime.config.paths.stateDir, (folder, id) =>
    runtime.turnController.isBusy(session.id) || runtime.sessionStore.liveProjectTurn(folder, id) !== null, choice);
  const view = result.panel.rows.length || (choice && !result.code) ? runtime.projectState?.(sessionId) : null;
  const deferred = new Set(view?.lessonCoverage?.filter(item => item.deferred).map(item => item.id));
  const approvedBinding = result.panel.rows.filter(row => row.lesson?.always && row.status.approvedByPerson && !deferred.has(row.id));
  const rows = result.panel.rows.map(row => row.lesson ? {
    ...row,
    promptEnds: projectLessonPromptEnds(row.lesson, 1 + approvedBinding.length - Number(approvedBinding.includes(row))),
  } : row);
  const running = result.code === "turn-running";
  const turnMessage = "Wait for the turn to finish.";
  const panel = { ...result.panel, rows, sectionLimit: PROJECT_LESSON_SECTION_LIMIT, ...(running ? { blocked: turnMessage } : {}) };
  if (result.code && (choice || !running)) {
    const message = running ? turnMessage
      : result.code === "busy" ? "Another process is saving the project record. Try again."
      : result.code === "io" ? "The project lesson choice could not be saved."
      : result.notice ?? result.panel.blocked ?? "Lesson choice refused.";
    return sendJson(res, status[result.code], { ...openaiError(message, "invalid_request_error", null, result.code), panel });
  }
  if (choice && view) ctx.projectGateBus?.publish({ type: "project_gate", sessionId, view });
  sendJson(res, 200, {
    session_id: sessionId,
    panel,
    notice: result.notice,
    ...(choice && view ? { view } : {}),
  });
};
