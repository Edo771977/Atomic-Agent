import { compressToolResult, type CompressedToolResult } from "../../compressor/result-compressor.js";
import { applyProjectUpdate, withProject, type ProjectUpdate, type ProjectUpdateOptions } from "../../session/session-project.js";
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
 * call's own error is kept. A refused `milestone_run` on a successful
 * fan-out keeps the success and notes the refusal.
 */
/**
 * Which tool may carry which update: each project tool its own kind, the
 * fan-out only the run record. Any other tool's `details.projectUpdate`
 * (an MCP server's, a skill script's) is ignored: the project moves only
 * through the tools that own it.
 */
const UPDATE_KIND_OF_TOOL: Readonly<Record<string, ProjectUpdate["kind"]>> = {
  "project.brief": "brief",
  "project.plan": "plan",
  "project.milestone": "milestone",
  "fusion.delegate": "milestone_run",
};

export function foldProjectUpdate(
  session: SessionState,
  result: CompressedToolResult,
  now: number,
  /** `stateDir`: where a milestone report's attachments must lie (issue #40). */
  options: ProjectUpdateOptions = {},
): { session: SessionState; result: CompressedToolResult } {
  const details = result.details as Record<string, unknown> | undefined;
  if (details === undefined || !(PROJECT_UPDATE_DETAIL in details)) return { session, result };
  const raw = details[PROJECT_UPDATE_DETAIL];
  const owned = UPDATE_KIND_OF_TOOL[result.tool];
  if (owned === undefined) return { session, result };
  const kind = typeof raw === "object" && raw !== null ? (raw as { kind?: unknown }).kind : undefined;
  if (kind !== undefined && kind !== owned) return { session, result };
  if (result.status !== "ok") {
    // A fan-out whose workers ran but failed still records its run on the
    // milestone (in progress, resumable); its own error stays the result.
    if (!isMilestoneRun(raw)) return { session, result };
    const run = applyProjectUpdate(session.project, raw, now);
    return run.ok ? { session: withProject(session, run.project), result } : { session, result };
  }
  const applied =
    typeof raw === "object" && raw !== null && typeof (raw as { kind?: unknown }).kind === "string"
      ? applyProjectUpdate(session.project, raw as ProjectUpdate, now, options)
      : { ok: false as const, error: { code: "invalid" as const, message: "the project update was malformed" } };
  if (applied.ok) return { session: withProject(session, applied.project), result };
  const rest = { ...details };
  delete rest[PROJECT_UPDATE_DETAIL];
  if (owned === "milestone_run") {
    // The fan-out itself worked: its result stands, with a note that the
    // milestone did not record the run.
    const kept = Object.defineProperties({}, Object.getOwnPropertyDescriptors(result)) as CompressedToolResult;
    kept.summary = `${result.summary}\n(note: the milestone was not updated: ${applied.error.message})`;
    kept.details = { ...rest, projectRefused: applied.error.code };
    return { session, result: kept };
  }
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
