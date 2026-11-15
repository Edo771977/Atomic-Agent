import type { ApprovalRequest } from "./approval-gate.js";

/** Reason shown on an approval prompt whose details were withheld (issue #33). */
export const APPROVAL_DETAILS_WITHHELD =
  "details withheld: this folder is restricted; open atomic-agent on the computer to see them";

/**
 * An approval prompt for a surface that may not receive the session's
 * content (a chat without "channels", a network `serve` without "serve",
 * issue #33): the tool and kind only. The preview, reason, resources and
 * the grant units (command, host, paths) are dropped, so no "Allow
 * always" rule is offered either. The gate still holds the full request;
 * only the copy that surface sees is cut.
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
