/**
 * The message a surface sends after the person's decision closed a
 * project gate and the director has work again (issue #39): the brief
 * approved (draft the plan), the plan or a milestone approved (run the
 * next milestone), or a milestone corrected (redo it with the note).
 * `null` when nothing should run: the gate is still open (an edit or a
 * variant re-estimated the plan and waits for approval again), the
 * project is cancelled or complete.
 *
 * The runtime never continues on its own: `projectDecision` only records
 * the verdict. Every surface that decides (TUI, CLI `--approve` and
 * `--auto-approve-project`, HTTP clients, the sidecar's desktop card,
 * Telegram) sends this text as the next user turn.
 *
 * Sent as an ordinary user turn so it takes the same queue, approval and
 * cancellation paths as typed text; the approval itself is already
 * recorded on the session by `projectDecision`, never by this text.
 */

import type { ProjectGateView } from "./project-gate-view.js";
import type { ProjectDecision } from "./session-project.js";

export function projectContinueMessage(view: ProjectGateView, decision: ProjectDecision): string | null {
  if (view.gate.kind !== "none") return null;
  const exp = view.expectation;
  if (exp.kind !== "draft_brief" && exp.kind !== "draft_plan" && exp.kind !== "run_milestone") return null;
  const title = (id: string): string => view.milestones.find((m) => m.id === id)?.title ?? id;
  const note = decision.edits?.note?.trim();
  const correction = decision.verdict === "edit" && note ? ` My correction: ${note}` : "";
  switch (exp.kind) {
    case "draft_brief":
      return `Revise the project brief.${correction}`;
    case "draft_plan":
      return "I approved the project brief. Draft the plan.";
    case "run_milestone":
      return correction
        ? `Redo milestone "${title(exp.id)}".${correction}`
        : `I approved. Continue with milestone "${title(exp.id)}".`;
  }
}
