import { sessionUnavailableToCaller } from "./serve-egress.js";
import { getConfig } from "../config/index.js";
import type { TeamMember } from "../llm/run-mode/fusion-team.js";
import { resolveLlmConfig } from "../llm/provider/registry/provider-types.js";
import { fusionTeamRoster, isCodexCliProvider } from "../runtime/session-director.js";
import { openaiError } from "./openai-errors.js";
import { sendError, sendJson, type HttpHandler } from "./request-context.js";

/**
 * `GET /api/fusion/team[?session=<id>]` (issue #71): the fusion team
 * (`llm.runMode.fusion.team`) by role, each member with `usable` and,
 * when not, `reason` (`folder` | `unreachable`) and `why`, so a client's
 * Director / Worker / Reviewer seats list only what can serve the chat
 * and show the rest disabled. With `session`, usability follows that
 * chat's folder restriction and `chat` carries its stamped choices
 * (`reviewer: "none"`: no review in this chat); without it, the server
 * folder's. The choices themselves are sent on the chat request
 * (`director` / `worker` / `reviewer`). Read only: config refs, no keys.
 */
export function createFusionTeamHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const { runtime } = ctx;
    const sessionId = new URL(req.url ?? "/", "http://localhost").searchParams.get("session");
    if (sessionId && sessionUnavailableToCaller(ctx, sessionId)) {
      return sendError(res, 404, openaiError("session not found"));
    }
    const session = sessionId === null || sessionId.length === 0 ? null : runtime.sessionStore.load(sessionId);
    if (sessionId !== null && sessionId.length > 0 && session === null) {
      sendError(res, 404, openaiError(`no session ${sessionId}`));
      return;
    }
    const target = session ?? { id: "", workingDir: runtime.capabilities.workingDir };
    const restriction = runtime.providerRestrictionFor?.(target) ?? null;
    const reachable = runtime.teamMemberReachable ??
      ((m: TeamMember): boolean => runtime.providerRegistry.getProvider(m.providerId) !== undefined);
    const resolved = resolveLlmConfig(getConfig());
    const runMode = resolved.runMode;
    const roster = fusionTeamRoster(runMode?.fusion, session?.metadata, restriction, reachable,
      (providerId) => isCodexCliProvider(resolved, providerId));
    const chat = session === null || roster === null ? {} : { chat: { session_id: session.id, ...roster.chat } };
    sendJson(res, 200, {
      configured: roster !== null,
      mode: runMode?.mode ?? null,
      directors: roster?.directors ?? [],
      workers: roster?.workers ?? [],
      reviewers: roster?.reviewers ?? [],
      review: roster?.review ?? null,
      restriction: restriction === null ? null : { label: restriction.label, allowedProviders: restriction.allowedProviders },
      ...chat,
    });
  };
}
