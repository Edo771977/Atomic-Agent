import { isIncognitoSession } from "../../session/incognito.js";
import type { SavedMilestoneReport } from "../../session/project-milestone-receipt.js";
import { compressToolResult, type CompressedToolResult } from "../../compressor/result-compressor.js";
import { applyProjectUpdate, withProject, type ProjectState, type ProjectUpdate, type ProjectUpdateOptions } from "../../session/session-project.js";
import type { SessionState } from "../../session/session-state.js";
import type { SessionProjectStore } from "../../session/session-project-store.js";

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
  "project.backlog.add": "backlog_add",
  "fusion.delegate": "milestone_run",
};

export function foldProjectUpdate(
  session: SessionState,
  result: CompressedToolResult,
  now: number,
  /** `stateDir`: where a milestone report's attachments must lie (issue #40). */
  options: ProjectUpdateOptions = {},
  /**
   * Issue #109: the project's folder store. The update is applied to the
   * project as the store holds it now (another chat may have changed it)
   * and written back there; a store that refuses the write refuses the
   * update. Absent: the project lives on the session, as before.
   */
  store?: SessionProjectStore,
  onMilestoneReport?: SavedMilestoneReport,
): { session: SessionState; result: CompressedToolResult } {
  const details = result.details as Record<string, unknown> | undefined;
  if (details === undefined || !(PROJECT_UPDATE_DETAIL in details)) return { session, result };
  const raw = details[PROJECT_UPDATE_DETAIL];
  const owned = UPDATE_KIND_OF_TOOL[result.tool];
  if (owned === undefined) return { session, result };
  const kind = typeof raw === "object" && raw !== null ? (raw as { kind?: unknown }).kind : undefined;
  if (kind !== undefined && kind !== owned) return { session, result };
  const base = store === undefined ? session : store.load(session);
  const land = (project: ProjectState): { ok: true; session: SessionState } | { ok: false; message: string } => {
    if (store === undefined) return { ok: true, session: withProject(base, project) };
    const written = store.commit(base, project);
    return written.ok ? written : { ok: false, message: written.problem.message };
  };
  if (result.status !== "ok") {
    // A fan-out whose workers ran but failed still records its run on the
    // milestone (in progress, resumable); its own error stays the result.
    if (!isMilestoneRun(raw)) return { session, result };
    const run = applyProjectUpdate(base.project, raw, now);
    if (!run.ok) return { session: base, result };
    const landed = land(run.project);
    return { session: landed.ok ? landed.session : base, result };
  }
  if (base.projectProblem !== undefined) {
    return refused(base, result, details, owned, { code: "project-unavailable", message: base.projectProblem });
  }
  const update = typeof kind === "string" ? raw as ProjectUpdate : undefined;
  const applied = update !== undefined
      ? applyProjectUpdate(base.project, update, now, options)
      : { ok: false as const, error: { code: "invalid" as const, message: "the project update was malformed" } };
  if (applied.ok) {
    const landed = land(applied.project);
    if (landed.ok) {
      if (update?.kind === "milestone" && update.holdForCorrection !== true && !isIncognitoSession(landed.session)) {
        onMilestoneReport?.(landed.session, update.id);
      }
      return { session: landed.session, result };
    }
    return refused(base, result, details, owned, { code: "project-store", message: landed.message });
  }
  return refused(base, result, details, owned, applied.error);
}

function refused(
  session: SessionState,
  result: CompressedToolResult,
  details: Record<string, unknown>,
  owned: ProjectUpdate["kind"],
  error: { code: string; message: string },
): { session: SessionState; result: CompressedToolResult } {
  const applied = { error };
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
