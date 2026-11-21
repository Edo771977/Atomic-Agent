import type { ProjectState } from "./session-project.js";

/**
 * Which "attention zone" a fusion project falls in (issue #121, for the
 * projects list of #109): what waits for the person comes first. One
 * pure function; the CLI's `projects list` rows carry it as `zone` and the
 * desktop groups its list by it, in {@link PROJECT_ATTENTION_ZONES} order.
 *
 * - `needs-you`: a gate (brief, plan or milestone) waits for the person,
 *   a gate changed outside Atomic Agent included;
 * - `problem`: a milestone failed, or the project cannot be opened
 *   (missing, damaged, unsupported: `project` null);
 * - `in-progress`: a milestone runs, or the project had activity within
 *   {@link IDLE_AFTER_DAYS} days and is not done;
 * - `idle`: no activity for {@link IDLE_AFTER_DAYS} days;
 * - `done`: every milestone reviewed, or the project was cancelled.
 */
export type ProjectAttentionZone = "needs-you" | "problem" | "in-progress" | "idle" | "done";

export const PROJECT_ATTENTION_ZONES: readonly ProjectAttentionZone[] = ["needs-you", "problem", "in-progress", "idle", "done"];

/** Days without activity after which a project is idle. */
export const IDLE_AFTER_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `lastActivity`: the project's last change (ms); `now` the clock to judge it by. */
export function projectAttentionZone(project: ProjectState | null, lastActivity: number | undefined, now: number): ProjectAttentionZone {
  if (project === null) return "problem";
  if (project.gate.kind !== "none") return "needs-you";
  if (project.milestones.some((m) => m.state === "failed")) return "problem";
  if (project.milestones.some((m) => m.state === "in_progress")) return "in-progress";
  if (project.cancelledAt !== undefined) return "done";
  if (project.milestones.length > 0 && project.milestones.every((m) => m.state === "reviewed")) return "done";
  const quiet = lastActivity === undefined || now - lastActivity > IDLE_AFTER_DAYS * DAY_MS;
  return quiet ? "idle" : "in-progress";
}

/** Zone order, then the most recent activity first (a row without one last in its zone). */
export function compareProjectAttention(a: { zone: ProjectAttentionZone; updatedAt?: number }, b: { zone: ProjectAttentionZone; updatedAt?: number }): number {
  const byZone = PROJECT_ATTENTION_ZONES.indexOf(a.zone) - PROJECT_ATTENTION_ZONES.indexOf(b.zone);
  if (byZone !== 0) return byZone;
  return (b.updatedAt ?? -Infinity) - (a.updatedAt ?? -Infinity) || 0;
}
