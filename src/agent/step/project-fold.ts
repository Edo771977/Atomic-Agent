import { compressToolResult, type CompressedToolResult } from "../../compressor/result-compressor.js";
import { applyProjectUpdate, withProject, type ProjectUpdate } from "../../session/session-project.js";
import type { SessionState } from "../../session/session-state.js";

/** Key of a project update in a result's `details` (`tools/fusion/project-tools.ts`). */
const PROJECT_UPDATE_DETAIL = "projectUpdate";

/**
 * Fold a director tool's `details.projectUpdate` (issue #39) into
 * `SessionState.project` through `applyProjectUpdate`, the one place the
 * project's rules are enforced (the model cannot approve; an update the
 * state does not allow is refused). A refusal replaces the result with
 * an error carrying the reason, so the transcript and the next step say
 * the update did not land. Errored calls and results without an update
 * pass through untouched, except a dispatch `milestone_run` on a failed
 * fan-out whose workers ran: it is folded (a refusal drops it) and the
 * call's own error is kept.
 */
export function foldProjectUpdate(
  session: SessionState,
  result: CompressedToolResult,
  now: number,
): { session: SessionState; result: CompressedToolResult } {
  const details = result.details as Record<string, unknown> | undefined;
  if (details === undefined || !(PROJECT_UPDATE_DETAIL in details)) return { session, result };
  const raw = details[PROJECT_UPDATE_DETAIL];
  if (result.status !== "ok") {
    // A fan-out whose workers ran but failed still records its run on the
    // milestone (in progress, resumable); its own error stays the result.
    if (!isMilestoneRun(raw)) return { session, result };
    const run = applyProjectUpdate(session.project, raw, now);
    return run.ok ? { session: withProject(session, run.project), result } : { session, result };
  }
  const applied =
    typeof raw === "object" && raw !== null && typeof (raw as { kind?: unknown }).kind === "string"
      ? applyProjectUpdate(session.project, raw as ProjectUpdate, now)
      : { ok: false as const, error: { code: "invalid" as const, message: "the project update was malformed" } };
  if (applied.ok) return { session: withProject(session, applied.project), result };
  const rest = { ...details };
  delete rest[PROJECT_UPDATE_DETAIL];
  return {
    session,
    result: compressToolResult({
      tool: result.tool,
      status: "error",
      output: `${result.tool} did not update the project: ${applied.error.message}`,
      details: { ...rest, projectRefused: applied.error.code },
    }),
  };
}

function isMilestoneRun(raw: unknown): raw is Extract<ProjectUpdate, { kind: "milestone_run" }> {
  return typeof raw === "object" && raw !== null && (raw as { kind?: unknown }).kind === "milestone_run";
}
