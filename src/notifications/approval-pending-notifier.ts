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
 * a reminder only: the prompt is answered in the app (a channel-owned
 * session already gets its own prompt there through the approval router).
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
  const head = `atomic-agent is waiting for your approval for ${options.minutes} min`;
  if (options.private) return `${head}. Answer it in the app.`;
  const folder = request.workdir ? basename(request.workdir) : "";
  const where = folder ? ` in ${folder}` : "";
  return `${head}: ${formatApprovalCategory(request.category)} (${request.tool})${where}. Answer it in the app.`;
}

export class ApprovalPendingNotifier implements ApprovalPendingObserver {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

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
    const timer = setTimeout(() => {
      this.timers.delete(request.approvalId);
      void this.fire(facts, minutes);
    }, minutes * 60_000);
    // A reminder must never keep the process alive.
    timer.unref?.();
    this.timers.set(request.approvalId, timer);
  }

  closed(approvalId: string): void {
    const timer = this.timers.get(approvalId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(approvalId);
  }

  /** Cancel every waiting reminder (runtime shutdown). */
  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private async fire(
    facts: Pick<ApprovalRequest, "sessionId" | "tool" | "category" | "workdir">,
    minutes: number,
  ): Promise<void> {
    const settings = this.deps.settings();
    if (!settings.enabled) return;
    if (this.deps.offline()) {
      this.deps.logger.debug("approval pending notice: offline mode, not sent", { minutes });
      return;
    }
    const text = formatApprovalPendingNotice(facts, {
      minutes,
      private: this.deps.isPrivate(facts.sessionId),
    });
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
    });
  }
}
