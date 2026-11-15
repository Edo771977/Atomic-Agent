import { canGrantCategory, type ApprovalRequest } from "../../approval/approval-gate.js";
import { siteGrantHost } from "../../approval/site-grants.js";
import {
  formatApprovalCategory,
  isAutoApprovedAt,
  type ApprovalCategory,
} from "../../approval/approval-level.js";
import type { CodingMode } from "./coding-mode.js";

/** The request fields the note reads; the modal passes the whole request. */
export type CodingModeNoteRequest = Pick<ApprovalRequest, "tool" | "category"> &
  Partial<Omit<ApprovalRequest, "tool" | "category">>;

/** Quiet from level 3 or 4: what `auto` (level 2) leaves asking and a higher level would not. */
function leftAskingByAuto(category: ApprovalCategory): boolean {
  return isAutoApprovedAt(4, category) && !isAutoApprovedAt(2, category);
}

/**
 * The line an approval prompt adds when the operator picked `auto` and
 * is still asked. Auto is approval level 2 (workspace file writes and
 * local page probes); everything quiet only from level 3 or 4 — shell
 * commands (`os.shell.run`, `verify.run` alike), HTTP, git remotes,
 * publishing and the rest — keeps asking, and without this the prompt
 * reads as auto not working. Risky shell commands (`shell_dangerous`)
 * are named too. The grant offered is the prompt's own `ctrl+f` one; a
 * category never granted for the session says each one asks. Level-5
 * categories get no line: no mode short of bypass covers them.
 */
export function codingModeApprovalNote(
  mode: CodingMode,
  request: CodingModeNoteRequest,
): string | null {
  if (mode !== "auto") return null;
  if (request.category === "shell") {
    const what = request.tool === "verify.run" ? "verification commands or remote pages" : "shell commands";
    return `auto mode doesn't cover ${what}; ctrl+f allows shell commands for this session (risky commands still ask)`;
  }
  if (request.category === "shell_dangerous") {
    const what = request.tool === "verify.run" ? "verification commands or remote pages" : "shell commands";
    return `auto mode doesn't cover risky ${what}; each one asks`;
  }
  if (!leftAskingByAuto(request.category)) return null;
  const head = `auto mode doesn't cover ${formatApprovalCategory(request.category)}`;
  const full = request as ApprovalRequest;
  if (!canGrantCategory(full)) return `${head}; each one asks`;
  const host = siteGrantHost(full);
  const scope = host !== null ? ` on ${host}` : request.grantKey !== undefined ? ` to ${request.grantKey}` : "";
  return `${head}; ctrl+f allows it${scope} for this session`;
}
