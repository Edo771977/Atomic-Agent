/**
 * ATO-1056 / ATO-1058 — the window's routes for "Roll back here", "Edit" and
 * "Fork from here" (renderer/chat-rewind.js), passed to the agent's rewind and
 * fork routes (chat-rewind.ts says which and how the answer is read):
 *
 *   agent:rewindPreview   what rolling back to a question would change (with `skip`, issue #83)
 *   agent:rewind          roll back: the agent puts the files back, then cuts the chat
 *   agent:forkSession     a new chat with the history through that question's answer
 *
 * The window names the chat and the question; nothing else reaches the agent.
 */

import { ipcMain } from "electron";

import { requestErrorText, type AgentClient } from "./agent-client.js";
import { rewindAnswer, rewindRequestBody, rewindSkipList, type RewindAnswer, type RewindRoute } from "./chat-rewind.js";

const CHANNELS: ReadonlyArray<[string, RewindRoute]> = [
  ["agent:rewindPreview", "rewind/preview"],
  ["agent:rewind", "rewind"],
  ["agent:forkSession", "fork"],
];

export function wireChatRewindIpc(client: Pick<AgentClient, "sessionRoute">): void {
  for (const [channel, route] of CHANNELS) {
    ipcMain.handle(channel, async (_event, payload: unknown): Promise<RewindAnswer> => {
      const { sessionId, priorQuestions, expectText, files, skip, acceptFailed, expectPlanHash, expectTranscriptRev } = (payload ?? {}) as {
        sessionId?: unknown; priorQuestions?: unknown; expectText?: unknown; files?: unknown; skip?: unknown; acceptFailed?: unknown;
        expectPlanHash?: unknown; expectTranscriptRev?: unknown;
      };
      if (typeof sessionId !== "string" || !sessionId) return { ok: false, supported: true, code: "session_not_found", error: "This chat is not saved yet" };
      // Issue #80: the files to leave as they are, a list of paths only; anything else is refused, not dropped
      // (dropped, the agent would put those files back after all).
      // A rollback and, issue #83, its preview take `skip` (the preview to show what a Continue would change).
      const takesSkip = route === "rewind" || route === "rewind/preview";
      if (takesSkip && rewindSkipList(skip) === null) return { ok: false, supported: true, error: "The files to leave as they are could not be read" };
      // Only a rollback takes `files` (ATO-1056: Edit, files and conversation or the conversation only)
      // and `skip` (issue #80: go ahead without the files a partial restore could not put back), or for an
      // agent without `skip`, `acceptFailed` (issue #77: go ahead, trying every file again).
      const body = rewindRequestBody(
        priorQuestions,
        expectText,
        route === "rewind" ? files : undefined,
        takesSkip ? skip : undefined,
        route === "rewind" ? acceptFailed : undefined,
        // Issue #83 review: the plan the confirm was shown; the agent refuses (plan_changed) when it differs.
        route === "rewind" ? expectPlanHash : undefined,
        // Issue #87: the messages the confirm was shown; refused the same way when they changed.
        route === "rewind" ? expectTranscriptRev : undefined,
      );
      if (body === null) return { ok: false, supported: true, error: "No message to go back to" };
      try {
        const res = await client.sessionRoute(sessionId, route, "POST", body);
        return rewindAnswer(res.status, res.body);
      } catch (err) {
        return { ok: false, supported: true, error: requestErrorText(err) };
      }
    });
  }
}
