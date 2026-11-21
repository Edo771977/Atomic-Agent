import type { AgentRuntime } from "../runtime/runtime-contract.js";
import { projectContinueMessage } from "../session/project-continue.js";
import { formatProjectGateText, projectApprovalLine, staleApprovalReason } from "../session/project-gate-text.js";
import type { ProjectDecision, ProjectState } from "../session/session-project.js";

/**
 * `run` at a fusion project gate (issue #39). An unattended run never
 * approves on its own: after a turn that left a gate open it prints the
 * gate and exits {@link PROJECT_GATE_EXIT} with the session id, and
 * `run --session <id> --approve <version>` approves that gate only at the
 * version the person read (a stale one is refused). Only the explicit
 * `--auto-approve-project` approves every gate at its current version as
 * it opens, printing each.
 */

/** `run`'s exit code for "stopped at a project gate; nothing failed". */
export const PROJECT_GATE_EXIT = 3;

export type ProjectGateStep =
  /** No project, or nothing waits on the person: carry on. */
  | { kind: "open" }
  /** A gate waits; print `text` and stop. */
  | { kind: "stop"; text: string }
  /**
   * Approved: print `line`; run `message` as the next turn when not null.
   * `project` is what the runtime stored: the caller's own session copy
   * must take it before that turn, or the turn's save puts the gate back.
   */
  | { kind: "approved"; line: string; message: string | null; project: ProjectState }
  /** The approval was refused (a hard cap, a stale version): print `text`. */
  | { kind: "failed"; text: string };

type GateRuntime = Pick<AgentRuntime, "projectState" | "projectDecision">;

/**
 * `mode`: `stop` prints the gate; `approve` approves its current version
 * (`--auto-approve-project` only); `{ version }` approves only that
 * version (`--approve <version>`).
 */
export async function settleProjectGate(
  runtime: GateRuntime,
  sessionId: string,
  mode: "stop" | "approve" | { version: number },
): Promise<ProjectGateStep> {
  const view = runtime.projectState?.(sessionId) ?? null;
  if (view === null || view.gate.kind === "none") return { kind: "open" };
  // `--auto-approve-project` would re-approve a failed milestone into
  // another run that fails the same way, forever: a retry, a correction
  // or a cancel is the person's call.
  const failedMilestone =
    mode === "approve" &&
    view.gate.kind === "milestone" &&
    view.milestones.find((m) => m.id === (view.gate as { id: string }).id)?.state === "failed";
  // Issue #109: content changed outside Atomic Agent (a hand or shell edit
  // of project.json, or a project from another machine) is not what the
  // person's standing --auto-approve-project covered: a person reads it.
  const changedOutside = mode === "approve" && view.changedOutside === true;
  if (mode === "stop" || failedMilestone || changedOutside) {
    return {
      kind: "stop",
      text: [
        ...(failedMilestone ? ["The milestone failed: this needs a person, so it is not approved automatically."] : []),
        ...(changedOutside ? ["This gate changed outside Atomic Agent since it was last decided: a person reads it, so it is not approved automatically."] : []),
        formatProjectGateText(view),
        `session: ${sessionId}`,
        `Approve with: atomic-agent run --session ${sessionId} --approve ${view.version ?? ""}`.trimEnd(),
        "Or continue the chat with --session to ask the director for changes.",
      ].join("\n"),
    };
  }
  if (runtime.projectDecision === undefined || view.version === null || !view.allowedVerdicts.includes("approve")) {
    return { kind: "failed", text: `${formatProjectGateText(view)}\nThis gate cannot be approved here.` };
  }
  if (typeof mode === "object") {
    const stale = staleApprovalReason(view, mode.version);
    if (stale !== null) return { kind: "failed", text: `${formatProjectGateText(view)}\nnot approved: ${stale}` };
  }
  const decision: ProjectDecision = { gate: view.gate, version: view.version, verdict: "approve" };
  const outcome = runtime.projectDecision(sessionId, decision);
  if (!outcome.ok && outcome.error.code === "review-open") {
    // Issue #100: a review still blocks the result. Approving over it is a
    // person's call, so a run stops here and says how to resume (exit 3),
    // not as a failure.
    return {
      kind: "stop",
      text: [
        `A review still blocks this milestone: this needs a person, so it is not approved automatically. ${outcome.error.message}`,
        formatProjectGateText(view),
        `session: ${sessionId}`,
        `Continue with: atomic-agent run --session ${sessionId}`,
        "and ask the director to fix what the review asked for, or decide over the review yourself.",
      ].join("\n"),
    };
  }
  if (!outcome.ok) {
    const why = outcome.error.code === "turn-running"
      ? `another turn is running on session ${sessionId}; approve again when it finishes`
      : outcome.error.message;
    return { kind: "failed", text: `${formatProjectGateText(view)}\nNot approved: ${why}` };
  }
  return { kind: "approved", line: projectApprovalLine(view), message: projectContinueMessage(outcome.view, decision), project: outcome.project };
}
