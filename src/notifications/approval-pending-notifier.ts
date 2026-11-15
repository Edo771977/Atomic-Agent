import { basename } from "node:path";

import type { ApprovalPendingObserver, ApprovalRequest } from "../approval/approval-gate.js";
import { formatApprovalCategory } from "../approval/approval-level.js";
import type { ApprovalPendingNotifyConfig } from "../config/index.js";
import type { StructuredLogger } from "../tracing/structured-logger.js";

/**
 * "The agent is waiting for you" (`notifications.approvalPending`, off by
 * default): when a prompt a person is asked has had no answer for
 * `afterMinutes`, one plain message per prompt goes to the paired owner
 * through a channel already running in this process. It opens no client
 * of its own: with no channel up, or offline mode on, nothing is sent.
 *
 * The message names the category, the tool and the project folder's
 * name, never the preview, arguments, resources or reason (a preview can
 * carry a secret); for an incognito chat it names nothing at all. It is
 * a reminder only: the prompt is answered in the app. A channel-owned
 * session already gets its own prompt there through the approval router,
 * so it gets no reminder. At most one reminder goes out a minute; those
 * due inside that minute go out at its end as one "N approvals are
 * waiting" message (one left: its own message).
 */

/** What a running channel offers: `TelegramChannel` / `DiscordChannel.sendOwnerNotice`. */
export interface OwnerNoticeSender {
  sendOwnerNotice(text: string): Promise<string>;
}

export interface ApprovalPendingNotifierDeps {
  /** Read live: when a prompt opens (on, minutes) and when it fires (on, channel). */
  settings: () => ApprovalPendingNotifyConfig;
  /** Offline mode (`isOfflineNetwork`), read when the timer fires. */
  offline: () => boolean;
  /** An incognito chat (or one open in this process): send generic text only. */
  isPrivate: (sessionId: string) => boolean;
  /** A session a channel owns (`ApprovalRouter.isRouted`): its prompt is already there; no reminder. */
  channelOwned: (sessionId: string) => boolean;
  /** The channels this process runs, or `null` when there is none. */
  telegram: () => OwnerNoticeSender | null;
  discord: () => OwnerNoticeSender | null;
  logger: Pick<StructuredLogger, "debug" | "warn">;
}

/** Outcomes that mean "this channel cannot carry it now": `auto` tries the next one. */
const UNAVAILABLE = new Set(["channel_not_up", "not_paired", "queued"]);

export function formatApprovalPendingNotice(
  request: Pick<ApprovalRequest, "tool" | "category" | "workdir">,
  options: { minutes: number; private: boolean },
): string {
  // An `ask_user` question (ATO-489) waits for an answer, not a yes.
  const what = request.category === "user_question" ? "answer" : "approval";
  const head = `atomic-agent is waiting for your ${what} for ${options.minutes} min`;
  if (options.private) return `${head}. Answer it in the app.`;
  const folder = request.workdir ? basename(request.workdir) : "";
  const where = folder ? ` in ${folder}` : "";
  return `${head}: ${formatApprovalCategory(request.category)} (${request.tool})${where}. Answer it in the app.`;
}

/** At most one reminder per this window; the ones due inside it go out merged at its end. */
export const APPROVAL_PENDING_NOTICE_INTERVAL_MS = 60_000;

/** A merged reminder: a count only, so it is safe for incognito chats too. */
export function formatApprovalPendingCount(count: number): string {
  return `atomic-agent: ${count} approvals are waiting for you. Answer them in the app.`;
}

type PendingFacts = Pick<ApprovalRequest, "sessionId" | "tool" | "category" | "workdir">;

export class ApprovalPendingNotifier implements ApprovalPendingObserver {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Reminders due inside the rate window, sent merged when it ends. */
  private readonly held = new Map<string, { facts: PendingFacts; minutes: number }>();
  private heldTimer: ReturnType<typeof setTimeout> | undefined;
  private lastSentAt: number | null = null;

  constructor(private readonly deps: ApprovalPendingNotifierDeps) {}

  opened(request: ApprovalRequest): void {
    const settings = this.deps.settings();
    if (!settings.enabled) return;
    this.closed(request.approvalId);
    // Only what the message needs is kept: the preview stays out of the closure.
    const facts = {
      sessionId: request.sessionId,
      tool: request.tool,
      category: request.category,
      ...(request.workdir !== undefined ? { workdir: request.workdir } : {}),
    };
    const minutes = settings.afterMinutes;
    const approvalId = request.approvalId;
    const timer = setTimeout(() => {
      this.timers.delete(approvalId);
      this.due(approvalId, facts, minutes);
    }, minutes * 60_000);
    // A reminder must never keep the process alive.
    timer.unref?.();
    this.timers.set(approvalId, timer);
  }

  closed(approvalId: string): void {
    this.held.delete(approvalId);
    const timer = this.timers.get(approvalId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(approvalId);
  }

  /** Cancel every waiting reminder (runtime shutdown). */
  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.held.clear();
    if (this.heldTimer !== undefined) clearTimeout(this.heldTimer);
    this.heldTimer = undefined;
  }

  /**
   * A prompt reached `afterMinutes`. Decided synchronously, so prompts
   * whose timers fire in one tick see each other: the first goes out,
   * the rest wait for the rate window and go out as one message.
   */
  private due(approvalId: string, facts: PendingFacts, minutes: number): void {
    if (!this.sendable(facts)) return;
    const now = Date.now();
    if (
      this.lastSentAt !== null &&
      now - this.lastSentAt < APPROVAL_PENDING_NOTICE_INTERVAL_MS
    ) {
      this.held.set(approvalId, { facts, minutes });
      if (this.heldTimer === undefined) {
        this.heldTimer = setTimeout(
          () => this.flushHeld(),
          this.lastSentAt + APPROVAL_PENDING_NOTICE_INTERVAL_MS - now,
        );
        this.heldTimer.unref?.();
      }
      return;
    }
    this.lastSentAt = now;
    void this.deliver(this.single(facts, minutes), minutes);
  }

  private flushHeld(): void {
    this.heldTimer = undefined;
    const waiting = [...this.held.values()].filter(({ facts }) => this.sendable(facts));
    this.held.clear();
    const first = waiting[0];
    if (first === undefined) return;
    this.lastSentAt = Date.now();
    const text =
      waiting.length === 1
        ? this.single(first.facts, first.minutes)
        : formatApprovalPendingCount(waiting.length);
    void this.deliver(text, first.minutes);
  }

  /**
   * Whether a reminder may go out for this prompt now. A session a
   * channel owns (`ApprovalRouter.isRouted`) already has its prompt, with
   * buttons, in the owner's DM: a reminder would only repeat it.
   */
  private sendable(facts: PendingFacts): boolean {
    if (!this.deps.settings().enabled) return false;
    if (this.deps.channelOwned(facts.sessionId)) return false;
    if (this.deps.offline()) {
      this.deps.logger.debug("approval pending notice: offline mode, not sent", {});
      return false;
    }
    return true;
  }

  private single(facts: PendingFacts, minutes: number): string {
    return formatApprovalPendingNotice(facts, {
      minutes,
      private: this.deps.isPrivate(facts.sessionId),
    });
  }

  private async deliver(text: string, minutes: number): Promise<void> {
    const settings = this.deps.settings();
    const order =
      settings.channel === "auto"
        ? (["telegram", "discord"] as const)
        : ([settings.channel] as const);
    for (const name of order) {
      const channel = this.deps[name]();
      if (channel === null) continue;
      let outcome: string;
      try {
        outcome = await channel.sendOwnerNotice(text);
      } catch {
        outcome = "delivery_failed";
      }
      if (outcome === "sent") return;
      if (UNAVAILABLE.has(outcome)) continue;
      // Delivered nowhere, but tried: one ping per prompt, not one per channel.
      this.deps.logger.warn("approval pending notice not delivered", { channel: name, outcome });
      return;
    }
    this.deps.logger.debug("approval pending notice: no running channel, not sent", {
      channel: settings.channel,
      minutes,
    });
  }
}
