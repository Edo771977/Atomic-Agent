import type { PushNotifyConfig } from "../config/index.js";
import {
  formatApprovalPush,
  formatTurnPush,
  isPushReady,
  readCurrentPushConfig,
  sendPush,
  type PushMessage,
} from "../notifications/index.js";
import type { ChatMessage, RunOutcome } from "./tui-state.js";

/**
 * The TUI's phone push (ATO-1129): the same two moments the terminal
 * bell covers — a turn that ran long or failed, and an approval left
 * waiting — sent to the ntfy topic in `notifications.push` when it is
 * on. Fire-and-forget: a push that does not go out never touches the
 * turn or the approval.
 */

/**
 * `notifications.push` when it can send now, else `null`. Read from disk,
 * so `atomic-agent push on` in another terminal counts. Never throws.
 */
export function readReadyPush(): PushNotifyConfig | null {
  const push = readCurrentPushConfig();
  return isPushReady(push) ? push : null;
}

/**
 * The text the turn that just ended answered with: the last assistant
 * message after the last prompt, interim progress notes skipped. `null`
 * when the turn left none (a failure, a stop, a tool-only finish).
 */
export function lastReplyOfTurn(messages: readonly ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "user" && !m.steered) return null;
    if (m.role === "assistant" && !m.progressNote) return m.text;
  }
  return null;
}

export function firePush(push: PushNotifyConfig, message: PushMessage): void {
  void sendPush({ push, message }).catch(() => undefined);
}

/** What the turn-end push says. */
export interface TurnPushFacts {
  outcome: RunOutcome;
  reason: string;
  stepCount: number;
  durationMs: number;
  messages: readonly ChatMessage[];
  workingDirName?: string | undefined;
}

/**
 * Whether a push about this session goes out generic: an incognito chat
 * (ATO-586) or one under a per-folder constraint or read taint (issue
 * #33). The push leaves the machine through a third-party service, so it
 * then carries no reply, failure text, folder name or tool, like the
 * approval-pending reminder (`isPrivate`).
 */
export interface PushPrivacy {
  private: boolean;
}

export function turnPushMessage(p: TurnPushFacts, privacy: PushPrivacy): PushMessage {
  return formatTurnPush({
    outcome: p.outcome,
    reply: !privacy.private && p.outcome === "completed" ? lastReplyOfTurn(p.messages) : null,
    reason: privacy.private ? "open Atomic Agent to see why" : p.reason,
    stepCount: p.stepCount,
    durationMs: p.durationMs,
    workingDirName: privacy.private ? undefined : p.workingDirName,
  });
}

export function approvalPushMessage(tool: string, privacy: PushPrivacy): PushMessage {
  const message = formatApprovalPush(tool);
  return privacy.private ? { ...message, body: "An approval is waiting. Open Atomic Agent to answer." } : message;
}

export function pushTurnEnd(push: PushNotifyConfig, p: TurnPushFacts, privacy: PushPrivacy = { private: false }): void {
  firePush(push, turnPushMessage(p, privacy));
}

/**
 * Ping about an approval only once it has waited `delayMs`: someone at
 * the keyboard answers first and the phone stays quiet. Returns the
 * cancel to call when the approval is answered. One ping per approval on
 * this channel: the approval-pending reminder (`notifications.approvalPending`)
 * goes to Telegram or Discord, never to the push topic, so the two never
 * repeat each other on one channel.
 */
export function schedulePushForApproval(
  tool: string,
  delayMs: number,
  privacy: PushPrivacy = { private: false },
): () => void {
  const timer = setTimeout(() => {
    const push = readReadyPush();
    if (push) firePush(push, approvalPushMessage(tool, privacy));
  }, Math.max(0, delayMs));
  timer.unref?.();
  return () => clearTimeout(timer);
}
