import type { ApprovalRequest } from "../approval/approval-gate.js";
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

/** Reason shown on an approval prompt whose details were withheld. */
export const APPROVAL_DETAILS_WITHHELD =
  "details withheld: this folder is restricted; open atomic-agent on the computer to see them";

/**
 * An approval prompt for a chat whose session may not send its content
 * there: the tool and kind only. The preview, reason, resources and the
 * grant units (command, host) are dropped, so no "Allow always" rule is
 * offered either. The gate still holds the full request; only the copy
 * the chat sees is cut.
 */
export function withholdApprovalDetails(request: ApprovalRequest): ApprovalRequest {
  return {
    approvalId: request.approvalId,
    sessionId: request.sessionId,
    tool: request.tool,
    category: request.category,
    reason: APPROVAL_DETAILS_WITHHELD,
  };
}

/** Wrap a chat's approval handler so a restricted session's prompt carries no details. */
export function gateApprovalHandler(
  runtime: ChannelSendCheck,
  sessionId: string,
  handler: (request: ApprovalRequest) => void,
): (request: ApprovalRequest) => void {
  const withheld = channelSendWithheld(runtime, sessionId);
  return (request) => handler(withheld() ? withholdApprovalDetails(request) : request);
}
