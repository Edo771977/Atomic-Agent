/**
 * `/plan` for Telegram (issue #39): the text fallback for a fusion
 * project gate. Bare `/plan` shows the open gate; `/plan approve` and
 * `/plan cancel` decide it at the version shown. The other verdicts
 * (edit rows, cheaper, quality, a milestone correction) need the card
 * of the terminal or the desktop app; a chat reply to the director can
 * still ask for changes, which redrafts and opens the gate again.
 *
 * Owner-gated by the inbound handler, like every command; the decision
 * itself is the runtime's (`projectDecision`), between turns only.
 */

import type { AgentRuntime } from "../../runtime/runtime-contract.js";
import { projectContinueMessage } from "../../session/project-continue.js";
import type { ProjectGateDecision } from "../../session/project-gate-view.js";
import { formatProjectGateText, projectApprovalLine } from "../../session/project-gate-text.js";

type ProjectRuntime = Pick<AgentRuntime, "projectState" | "projectDecision">;

const VERDICT_HINT = "Reply /plan approve or /plan cancel. To change it, tell me what to change; edit rows, cheaper and quality are in the terminal or the desktop app.";

export interface ProjectCommandResult {
  text: string;
  /** Sent as the chat's next turn when the decision closed a gate on director work. */
  continueWith: string | null;
}

/** The message after a turn that left a gate open; `null` when nothing waits. */
export function projectGateNotice(runtime: ProjectRuntime, sessionId: string): string | null {
  const view = runtime.projectState?.(sessionId);
  if (view === undefined || view.gate.kind === "none") return null;
  return `${formatProjectGateText(view)}\n${VERDICT_HINT}`;
}

export async function runProjectCommand(
  args: readonly string[],
  deps: { runtime: ProjectRuntime; sessionId: string | null; busy: boolean },
): Promise<ProjectCommandResult> {
  const say = (text: string): ProjectCommandResult => ({ text, continueWith: null });
  const verb = (args[0] ?? "").toLowerCase();
  if (verb !== "" && verb !== "approve" && verb !== "cancel") {
    return say("Usage: /plan shows the project gate · /plan approve · /plan cancel");
  }
  const view = deps.sessionId === null ? undefined : deps.runtime.projectState?.(deps.sessionId);
  if (deps.sessionId === null || view === undefined) return say("This chat has no project.");
  if (verb === "") {
    return say(view.gate.kind === "none" ? formatProjectGateText(view) : `${formatProjectGateText(view)}\n${VERDICT_HINT}`);
  }
  if (deps.busy) return say("Wait for the current turn to finish, then decide.");
  if (view.gate.kind === "none" && verb === "approve") return say("Nothing waits for your approval.");
  if (deps.runtime.projectDecision === undefined) return say("This agent takes no project decisions.");
  const decision: ProjectGateDecision = { gate: view.gate, version: view.version, verdict: verb };
  const outcome = await deps.runtime.projectDecision(deps.sessionId, decision);
  if (!outcome.ok) return say(`Not ${verb === "approve" ? "approved" : "cancelled"}: ${outcome.error.message}`);
  if (verb === "cancel") return say("Project cancelled.");
  const line = projectApprovalLine(view);
  return { text: `${line.charAt(0).toUpperCase()}${line.slice(1)}.`, continueWith: projectContinueMessage(outcome.view, decision) };
}
