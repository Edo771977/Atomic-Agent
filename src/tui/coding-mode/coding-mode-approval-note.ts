import type { ApprovalCategory } from "../../approval/approval-level.js";
import type { CodingMode } from "./coding-mode.js";

/**
 * The line an approval prompt adds when the operator picked `auto` and
 * is still asked: auto is approval level 2 (workspace file writes), and
 * shell commands — `os.shell.run` and `verify.run` alike — sit at level
 * 4, so they keep asking. Without this the prompt reads as auto not
 * working. Risky commands (`shell_dangerous`) are never granted for the
 * session, so the note does not offer the category grant for them.
 */
export function codingModeApprovalNote(
  mode: CodingMode,
  request: { readonly tool: string; readonly category: ApprovalCategory },
): string | null {
  if (mode !== "auto") return null;
  const what = request.tool === "verify.run" ? "verification commands or remote pages" : "shell commands";
  if (request.category === "shell") {
    return `auto mode doesn't cover ${what}; ctrl+f allows shell commands for this session (risky commands still ask)`;
  }
  if (request.category === "shell_dangerous") {
    return `auto mode doesn't cover risky ${what}; each one asks`;
  }
  return null;
}
