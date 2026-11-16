import type { AgentRuntime } from "../runtime/runtime-contract.js";
import { projectContinueMessage } from "../session/project-continue.js";
import type { ProjectGateDecision } from "../session/project-gate-view.js";
import { formatProjectGateText, projectApprovalLine } from "../session/project-gate-text.js";

/**
 * `run` at a fusion project gate (issue #39). An unattended run never
 * approves on its own: after a turn that left a gate open it prints the
 * gate and exits {@link PROJECT_GATE_EXIT} with the session id, and
 * `run --session <id> --approve` approves that gate. Only the explicit
 * `--auto-approve-project` approves every gate as it opens, printing each.
 */

/** `run`'s exit code for "stopped at a project gate; nothing failed". */
export const PROJECT_GATE_EXIT = 3;

export type ProjectGateStep =
  /** No project, or nothing waits on the person: carry on. */
  | { kind: "open" }
  /** A gate waits; print `text` and stop. */
  | { kind: "stop"; text: string }
  /** Approved: print `line`; run `message` as the next turn when not null. */
  | { kind: "approved"; line: string; message: string | null }
  /** The approval was refused (a hard cap, a stale version): print `text`. */
  | { kind: "failed"; text: string };

type GateRuntime = Pick<AgentRuntime, "projectState" | "projectDecision">;

export async function settleProjectGate(
  runtime: GateRuntime,
  sessionId: string,
  mode: "stop" | "approve",
): Promise<ProjectGateStep> {
  const view = runtime.projectState?.(sessionId);
  if (view === undefined || view.gate.kind === "none") return { kind: "open" };
  if (mode === "stop") {
    return {
      kind: "stop",
      text: [
        formatProjectGateText(view),
        `session: ${sessionId}`,
        `Approve with: atomic-agent run --session ${sessionId} --approve`,
        "Or continue the chat with --session to ask the director for changes.",
      ].join("\n"),
    };
  }
  if (runtime.projectDecision === undefined || !view.allowedVerdicts.includes("approve")) {
    return { kind: "failed", text: `${formatProjectGateText(view)}\nThis gate cannot be approved here.` };
  }
  const decision: ProjectGateDecision = { gate: view.gate, version: view.version, verdict: "approve" };
  const outcome = await runtime.projectDecision(sessionId, decision);
  if (!outcome.ok) {
    return { kind: "failed", text: `${formatProjectGateText(view)}\nNot approved: ${outcome.error.message}` };
  }
  return { kind: "approved", line: projectApprovalLine(view), message: projectContinueMessage(outcome.view, decision) };
}
