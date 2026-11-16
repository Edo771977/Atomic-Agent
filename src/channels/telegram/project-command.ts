/**
 * `/plan` for Telegram (issue #39): the text fallback for a fusion
 * project gate. Bare `/plan` shows the open gate; `/plan approve <v>`
 * approves it only at the version the person read (bare `/plan approve`
 * shows the gate and asks again with its version; a stale one is
 * refused) and `/plan cancel` cancels. The other verdicts
 * (edit rows, cheaper, quality, a milestone correction) need the card
 * of the terminal or the desktop app; a chat reply to the director can
 * still ask for changes, which redrafts and opens the gate again.
 *
 * Owner-gated by the inbound handler, like every command; the decision
 * itself is the runtime's (`projectDecision`), between turns only.
 */

import type { AgentRuntime } from "../../runtime/runtime-contract.js";
import { projectContinueMessage } from "../../session/project-continue.js";
import { formatProjectGateText, projectApprovalLine, staleApprovalReason } from "../../session/project-gate-text.js";
import type { ProjectGateView } from "../../session/project-gate-view.js";
import type { ProjectDecision } from "../../session/session-project.js";

type ProjectRuntime = Pick<AgentRuntime, "projectState" | "projectDecision">;

const verdictHint = (view: ProjectGateView): string =>
  `Reply /plan approve ${view.version ?? ""} or /plan cancel. To change it, tell me what to change; edit rows, cheaper and quality are in the terminal or the desktop app.`;

export interface ProjectCommandResult {
  text: string;
  /** Sent as the chat's next turn when the decision closed a gate on director work. */
  continueWith: string | null;
}

/** The message after a turn that left a gate open; `null` when nothing waits. */
export function projectGateNotice(runtime: ProjectRuntime, sessionId: string): string | null {
  const view = runtime.projectState?.(sessionId) ?? null;
  if (view === null || view.gate.kind === "none") return null;
  return `${formatProjectGateText(view)}\n${verdictHint(view)}`;
}

export async function runProjectCommand(
  args: readonly string[],
  deps: { runtime: ProjectRuntime; sessionId: string | null; busy: boolean },
): Promise<ProjectCommandResult> {
  const say = (text: string): ProjectCommandResult => ({ text, continueWith: null });
  const verb = (args[0] ?? "").toLowerCase();
  const usage = say("Usage: /plan shows the project gate · /plan approve <version> · /plan cancel");
  if (verb !== "" && verb !== "approve" && verb !== "cancel") return usage;
  const rawVersion = args[1];
  if (rawVersion !== undefined && (verb !== "approve" || !/^\d+$/.test(rawVersion))) return usage;
  const version = rawVersion === undefined ? null : Number(rawVersion);
  const view = deps.sessionId === null ? null : (deps.runtime.projectState?.(deps.sessionId) ?? null);
  if (deps.sessionId === null || view === null) return say("This chat has no project.");
  if (verb === "") {
    return say(view.gate.kind === "none" ? formatProjectGateText(view) : `${formatProjectGateText(view)}\n${verdictHint(view)}`);
  }
  if (deps.busy) return say("Wait for the current turn to finish, then decide.");
  if (view.gate.kind === "none" && verb === "approve") return say("Nothing waits for your approval.");
  if (deps.runtime.projectDecision === undefined) return say("This agent takes no project decisions.");
  if (view.version === null) return say("Nothing waits for your decision.");
  if (verb === "approve") {
    // Only the version the person read: an approval typed from an older
    // message must not approve a brief or plan that changed since.
    if (version === null) return say(`${formatProjectGateText(view)}\nTo approve this version, reply /plan approve ${view.version}.`);
    const stale = staleApprovalReason(view, version);
    if (stale !== null) return say(`Not approved: ${stale}. Reply /plan to see it.`);
  }
  const decision: ProjectDecision = { gate: view.gate, version: view.version, verdict: verb };
  const outcome = deps.runtime.projectDecision(deps.sessionId, decision);
  if (!outcome.ok) {
    const why = outcome.error.code === "turn-running" ? "a turn is running; decide when it finishes." : outcome.error.message;
    return say(`Not ${verb === "approve" ? "approved" : "cancelled"}: ${why}`);
  }
  if (verb === "cancel") return say("Project cancelled.");
  const line = projectApprovalLine(view);
  return { text: `${line.charAt(0).toUpperCase()}${line.slice(1)}.`, continueWith: projectContinueMessage(outcome.view, decision) };
}
