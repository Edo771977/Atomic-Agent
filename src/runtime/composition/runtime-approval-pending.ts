import type { ApprovalGate } from "../../approval/approval-gate.js";
import type { ApprovalPendingNotifyConfig } from "../../config/index.js";
import { isOfflineNetwork } from "../../llm/offline-network.js";
import {
  ApprovalPendingNotifier,
  type OwnerNoticeSender,
} from "../../notifications/index.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";

/**
 * Wire the approval-pending reminder (`notifications.approvalPending`) to
 * the gate. The channels are resolved when a reminder fires, not now:
 * they are connected after this runs and may be stopped, restarted or
 * switched off later, and only one that is up in this process sends.
 * `dispose` (shutdown) detaches the observer and drops waiting timers.
 */
export function installApprovalPendingNotifier(args: {
  approvals: Pick<ApprovalGate, "setPendingObserver">;
  readSettings: () => ApprovalPendingNotifyConfig;
  /** `SessionStore.isIncognito`; a lookup that throws counts as incognito. */
  isIncognito: (sessionId: string) => boolean;
  /** Any incognito chat open in this process (a worker of one has no row). */
  anyIncognitoOpen: () => boolean;
  resolveTelegram: () => OwnerNoticeSender | null;
  resolveDiscord: () => OwnerNoticeSender | null;
  logger: Pick<StructuredLogger, "debug" | "warn">;
  /** Default `isOfflineNetwork`. */
  offline?: () => boolean;
}): { dispose(): void } {
  const notifier = new ApprovalPendingNotifier({
    settings: args.readSettings,
    offline: args.offline ?? isOfflineNetwork,
    isPrivate: (sessionId) => {
      try {
        return args.anyIncognitoOpen() || args.isIncognito(sessionId);
      } catch {
        return true;
      }
    },
    telegram: args.resolveTelegram,
    discord: args.resolveDiscord,
    logger: args.logger,
  });
  args.approvals.setPendingObserver(notifier);
  return {
    dispose: () => {
      args.approvals.setPendingObserver(undefined);
      notifier.dispose();
    },
  };
}
