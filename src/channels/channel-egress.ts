import type { ApprovalRequest } from "../approval/approval-gate.js";
import { withholdApprovalDetails } from "../approval/approval-details-withheld.js";
import { CHANNEL_RESTRICTED_NOTICE } from "../runtime/session-provider-policy.js";

/**
 * Per-folder egress for chat adapters (issue #33). The runtime refuses a
 * chat turn for a constrained folder before the queue, but a turn can
 * become constrained while it runs (a read inside a constrained folder
 * taints it), so every outbound send asks again: the reply, progress
 * labels and snapshots, budget notices, files, and the details of an
 * approval prompt. A refused send is replaced by the fixed
 * `CHANNEL_RESTRICTED_NOTICE`, once per turn.
 */
export interface ChannelSendCheck {
  readonly channelSendRefusal?: (sessionId: string) => string | null;
}

/**
 * `() => true` while this session's content may not reach the chat. A
 * throwing check withholds (fail closed); a runtime without the check
 * (hand-built test runtimes) allows.
 */
export function channelSendWithheld(runtime: ChannelSendCheck, sessionId: string): () => boolean {
  return () => {
    const check = runtime.channelSendRefusal;
    if (check === undefined) return false;
    try {
      return check(sessionId) !== null;
    } catch {
      return true;
    }
  };
}

export { CHANNEL_RESTRICTED_NOTICE };
export { APPROVAL_DETAILS_WITHHELD, withholdApprovalDetails } from "../approval/approval-details-withheld.js";

/** Wrap a chat's approval handler so a restricted session's prompt carries no details. */
export function gateApprovalHandler(
  runtime: ChannelSendCheck,
  sessionId: string,
  handler: (request: ApprovalRequest) => void,
): (request: ApprovalRequest) => void {
  const withheld = channelSendWithheld(runtime, sessionId);
  return (request) => handler(withheld() ? withholdApprovalDetails(request) : request);
}
