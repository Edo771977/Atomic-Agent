import { isAbsolute, resolve } from "node:path";

import { listedProjectFolder, listProjectRows, resumeProjectChat } from "../cli/projects-command.js";
import { forgetProjectFolder } from "../session/project-registry.js";
import { projectStoreForStateDir } from "../session/session-project-store.js";
import { openaiError } from "./openai-errors.js";
import { readJsonBody, sendError, sendJson, type HandlerContext, type HttpHandler } from "./request-context.js";
import { SERVE_RESTRICTED_CODE, SERVE_RESTRICTED_NOTICE, serveWithheld } from "./serve-egress.js";

/**
 * The fusion projects this machine knows over HTTP (issue #109), for the
 * desktop's projects list: `GET /api/projects` (the `projects list --json`
 * rows), `POST /api/projects/forget` `{ folder }` and
 * `POST /api/projects/resume` `{ folder }` (`project resume`'s chat: the
 * newest chat on the folder's project, or a new one). Every answer carries
 * `schema: 1`. The listing and the resume are the CLI's own code.
 */

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function folderOf(body: unknown): string | null {
  if (!isObject(body)) return null;
  const f = body.folder;
  if (typeof f !== "string" || f.length === 0 || f.length > 4096 || /[\r\n\0]/.test(f) || !isAbsolute(f)) return null;
  return resolve(f);
}

/** On a network server, a folder whose constraint lacks `serve` is not shown or touched (issue #74). */
const withheld = (ctx: HandlerContext, folder: string): boolean => serveWithheld(ctx, { id: "", workingDir: folder })();

const stateDirOf = (ctx: HandlerContext): string => ctx.runtime.config.paths.stateDir;

function sendWithheld(res: Parameters<HttpHandler>[1]): void {
  sendError(res, 403, openaiError(SERVE_RESTRICTED_NOTICE, "permission_error", null, SERVE_RESTRICTED_CODE));
}

async function folderBody(req: Parameters<HttpHandler>[0], res: Parameters<HttpHandler>[1], ctx: HandlerContext): Promise<string | null> {
  let body: unknown;
  try {
    body = await readJsonBody<unknown>(req);
  } catch (err) {
    sendError(res, 400, openaiError(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`));
    return null;
  }
  const folder = folderOf(body);
  if (folder === null) {
    sendError(res, 400, openaiError("folder must be an absolute path"));
    return null;
  }
  if (withheld(ctx, folder)) {
    sendWithheld(res);
    return null;
  }
  return folder;
}

export function createListProjectsHandler(): HttpHandler {
  return (_req, res, ctx) => {
    const listed = listProjectRows(stateDirOf(ctx), undefined, (folder) => !withheld(ctx, folder));
    sendJson(res, 200, {
      schema: 1,
      projects: listed.rows,
      registry_problem: listed.registryProblem ?? null,
    });
  };
}

export function createForgetProjectHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const folder = await folderBody(req, res, ctx);
    if (folder === null) return;
    sendJson(res, 200, { schema: 1, folder, forgotten: forgetProjectFolder(stateDirOf(ctx), folder) });
  };
}

export function createResumeProjectHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const asked = await folderBody(req, res, ctx);
    if (asked === null) return;
    const stateDir = stateDirOf(ctx);
    const folder = listedProjectFolder(stateDir, asked);
    const refuse = (status: number, code: string, message: string) =>
      sendJson(res, status, { schema: 1, folder: folder ?? asked, error: { message, type: "invalid_request_error", code } });
    if (folder === null) return refuse(404, "not-listed", `${asked} is not in the projects list.`);
    if (withheld(ctx, folder)) {
      sendWithheld(res);
      return;
    }
    const resumed = resumeProjectChat(folder, { stateDir, sessionStore: ctx.runtime.sessionStore, projectStore: projectStoreForStateDir(stateDir) });
    if (!resumed.ok) return refuse(422, "project-unavailable", resumed.problem);
    if (serveWithheld(ctx, resumed.session)()) {
      sendWithheld(res);
      return;
    }
    sendJson(res, 200, {
      schema: 1, folder, name: resumed.name, session_id: resumed.session.id, created: resumed.created,
      view: ctx.runtime.projectState?.(resumed.session.id) ?? null,
    });
  };
}
