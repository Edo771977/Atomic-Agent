/**
 * `/plan` for Telegram (issue #39): the text fallback for a fusion
 * project gate. Bare `/plan` shows the open gate; `/plan approve <v>`
 * approves it only at the version the person read (bare `/plan approve`
 * shows the gate and asks again with its version; a stale one is
 * refused) and `/plan cancel` cancels. At the plan gate, `/defer`
 * and `/reactivate` change the status of an approved brief decision.
 * Editing rows, cheaper, quality and milestone corrections need the card
 * of the terminal or the desktop app; a chat reply to the director can
 * still ask for changes, which redrafts and opens the gate again.
 *
 * Owner-gated by the inbound handler, like every command; the decision
 * itself is the runtime's (`projectDecision`), between turns only.
 */

import type { AgentRuntime } from "../../runtime/runtime-contract.js";
import { projectContinueMessage } from "../../session/project-continue.js";
import { normalizeCriterionId } from "../../session/project-criterion-id.js";
import { formatProjectGateText, projectApprovalLine, staleApprovalReason } from "../../session/project-gate-text.js";
import type { ProjectGateView } from "../../session/project-gate-view.js";
import type { ProjectDecision } from "../../session/session-project.js";

type ProjectRuntime = Pick<AgentRuntime, "projectState" | "projectDecision">;
type ProjectCommandDeps = { runtime: ProjectRuntime; sessionId: string | null; busy: boolean };

function gateMessage(view: ProjectGateView): string {
  const text = formatProjectGateText(view);
  if (view.gate.kind === "none") return text;
  const verdicts = `Reply /plan approve ${view.version ?? ""} or /plan cancel. To change it, tell me what to change. Edit rows, cheaper and quality are in the terminal or the desktop app.`;
  const review = view.allowedVerdicts.includes("approveOverReview")
    ? " Approving over the open review notes (with your reason) is in the terminal or the desktop app."
    : "";
  const decisions = view.gate.kind === "plan" && view.allowedVerdicts.includes("edit") &&
    view.decisions?.some(({ status }) => status === "active" || status === "deferred")
    ? "\nUse /defer <id> or /reactivate <id> to review a decision status change."
    : "";
  const lessons = view.gate.kind === "plan" && view.allowedVerdicts.includes("edit") && view.lessonCoverage?.length
    ? "\nUse /lesson_defer <id> or /lesson_activate <id> to preview a binding lesson's status change."
    : "";
  return `${text}\n${verdicts}${review}${decisions}${lessons}`;
}

export interface ProjectCommandResult {
  text: string;
  /** Sent as the chat's next turn when the decision closed a gate on director work. */
  continueWith: string | null;
}

const say = (text: string): ProjectCommandResult => ({ text, continueWith: null });

/** The message after a turn that left a gate open; `null` when nothing waits. */
export function projectGateNotice(runtime: ProjectRuntime, sessionId: string): string | null {
  const view = runtime.projectState?.(sessionId) ?? null;
  if (view === null || view.gate.kind === "none") return null;
  return gateMessage(view);
}

export async function runProjectCommand(
  args: readonly string[],
  deps: ProjectCommandDeps,
): Promise<ProjectCommandResult> {
  const verb = (args[0] ?? "").toLowerCase();
  const usage = say("Usage: /plan shows the project gate · /plan approve <version> · /plan cancel");
  if (verb !== "" && verb !== "approve" && verb !== "cancel") return usage;
  const rawVersion = args[1];
  if (rawVersion !== undefined && (verb !== "approve" || !/^\d+$/.test(rawVersion))) return usage;
  const version = rawVersion === undefined ? null : Number(rawVersion);
  const view = deps.sessionId === null ? null : (deps.runtime.projectState?.(deps.sessionId) ?? null);
  if (deps.sessionId === null || view === null) return say("This chat has no project.");
  if (verb === "") {
    return say(gateMessage(view));
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

/** A status change uses the version the owner read and keeps the plan gate open. */
export function runDecisionStatusCommand(
  verb: "defer" | "reactivate",
  args: readonly string[],
  { runtime, sessionId, busy }: ProjectCommandDeps,
): ProjectCommandResult {
  const [rawId, rawVersion] = args;
  const id = normalizeCriterionId(rawId);
  const version = rawVersion === undefined ? null : Number(rawVersion);
  if (id === null || args.length > 2 ||
      (rawVersion !== undefined && (!/^\d+$/.test(rawVersion) || !Number.isSafeInteger(version)))) {
    return say(`Usage: /${verb} <id> [version]. Reply /plan to see the decision IDs.`);
  }
  const view = sessionId === null ? null : (runtime.projectState?.(sessionId) ?? null);
  if (sessionId === null || view === null) return say("This chat has no project.");
  if (busy) return say("Wait for the current turn to finish, then decide.");
  if (view.gate.kind !== "plan" || view.version === null || !view.allowedVerdicts.includes("edit")) {
    return say("Decision status can change while an editable plan waits for your approval. Reply /plan to see the current gate.");
  }
  if (runtime.projectDecision === undefined) return say("This agent takes no project decisions.");
  if (version !== null) {
    const stale = staleApprovalReason(view, version);
    if (stale !== null) return say(`Decision unchanged. ${stale}. Reply /plan to see it.`);
  }
  const entry = view.decisions?.find((item) => item.id === id);
  if (entry === undefined) return say(`Unknown decision ${id}. Reply /plan to see the decision IDs.`);
  const target = verb === "defer" ? "deferred" : "active";
  const source = verb === "defer" ? "active" : "deferred";
  if (entry.status === target) return say(`Decision ${id} is already ${target}.`);
  if (entry.status !== source) return say(`Decision ${id} is ${entry.status}. Only ${source} decisions can be changed with /${verb}.`);
  if (version === null) {
    return say(`Decision ${id} (${entry.status})\n${entry.text}\n\nTo ${verb} it, reply /${verb} ${id} ${view.version}.`);
  }
  const outcome = runtime.projectDecision(sessionId, {
    gate: view.gate,
    version,
    verdict: "edit",
    edits: { decisionStatus: { [id]: target } },
  });
  if (!outcome.ok) return say(`Decision unchanged. ${outcome.error.message}`);
  return say(`Decision ${id} is now ${target}.\n${gateMessage(outcome.view)}`);
}
