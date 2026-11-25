import { isChannelLockConflict } from "../channels/channel-lock-error.js";

import { otherPollerOf } from "./route-telegram-channel.js";
import { sendJson, type HttpHandler } from "./request-context.js";

/**
 * `GET /api/discord/channel` — the Discord channel's live state (ATO-516).
 *
 * The desktop's Discord tab only knew what it had saved (a token, the owner
 * ids, the on switch), not whether the bot is connected. This is what it
 * polls to say so, as `GET /api/telegram/channel` does for Telegram.
 *
 * Answers `{ available, state, lastError, hasToken, otherPoller }`:
 * `state` is the channel's `up` / `down` / `disabled` / `starting` /
 * `stopping`; `lastError` is the fixed `channel_error` or null, never
 * provider text. `otherPoller` is `{ where: "this_computer", pid }` when
 * another atomic-agent on this computer holds `discord.lock`, `null`
 * otherwise. `available: false` on an agent without the channel. The token
 * itself is never in the answer. Bearer auth like every `/api` route.
 */
export function createDiscordChannelHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    res.setHeader("cache-control", "no-store");
    const channel = ctx.runtime.discordChannel ?? null;
    if (!channel) {
      sendJson(res, 200, { available: false, state: null, lastError: null, hasToken: false, otherPoller: null });
      return;
    }
    const lastError = channel.lastError();
    sendJson(res, 200, {
      available: true,
      state: channel.state(),
      lastError: isChannelLockConflict(lastError) ? "channel_locked" : lastError ? "channel_error" : null,
      hasToken: channel.hasToken(),
      otherPoller: discordOtherPollerOf(lastError),
    });
  };
}

/** Another atomic-agent on this computer holding the bot, read from the last error. */
export function discordOtherPollerOf(
  lastError: string | null,
): { where: "this_computer"; pid: number | null } | null {
  if (!lastError || !isChannelLockConflict(lastError)) return null;
  const other = otherPollerOf(lastError);
  return other && other.where === "this_computer" ? other : { where: "this_computer", pid: null };
}
