import { resolve as resolvePath } from "node:path";

import { isInside } from "../../approval/fanout-scope.js";
import type { AssignmentRow, ProjectState } from "../../session/session-project.js";

/**
 * The fusion project's dispatch gate (issue #39), enforced by
 * `fusion.delegate` before anything starts, never by prompt wording.
 * With no project the fan-out runs as before. With one: nothing runs
 * while the person has a gate open, before the plan is approved, or
 * after a cancel; a task of the plan runs only while its milestone is
 * approved (or in progress, for a rework round); a task outside the plan
 * is admitted, and asks the person like any fan-out.
 */
export type ProjectDispatchVerdict =
  | { kind: "no-project" }
  | {
      kind: "refuse";
      reason: "cancelled" | "awaiting-person" | "plan-not-approved" | "milestone-not-approved";
      /** For the director: what to do instead. */
      message: string;
    }
  | {
      kind: "admit";
      /** The approved milestone the call's plan tasks belong to; null when none of them is in the plan. */
      milestoneId: string | null;
      /** Task ids of the call that are rows of the plan, in call order. */
      planned: string[];
      /** Task ids outside the plan. */
      unplanned: string[];
    };

const REPLY = "Reply to the person and wait for their decision";

export function checkProjectDispatch(project: ProjectState | undefined, taskIds: readonly string[]): ProjectDispatchVerdict {
  if (project === undefined) return { kind: "no-project" };
  if (project.cancelledAt !== undefined) {
    return {
      kind: "refuse",
      reason: "cancelled",
      message: "The person cancelled this project, so nothing is delegated for it. Tell them; a new project starts with project.brief.",
    };
  }
  const gate = project.gate;
  if (gate.kind !== "none") {
    const what = gate.kind === "brief" ? "the brief" : gate.kind === "plan" ? "the plan" : `milestone ${gate.id}'s result`;
    return { kind: "refuse", reason: "awaiting-person", message: `${what} waits for the person's approval. ${REPLY}; delegate after it is approved.` };
  }
  const plan = project.plan;
  if (project.brief?.status !== "approved" || plan === undefined || plan.status !== "approved") {
    const next = project.brief?.status !== "approved" ? "draft the brief with project.brief" : "draft the plan with project.plan";
    return { kind: "refuse", reason: "plan-not-approved", message: `Nothing runs before the plan is approved: ${next}, then reply so the person can approve it.` };
  }
  const rows = new Map(plan.rows.map((r) => [r.taskId, r]));
  const planned = taskIds.filter((id) => rows.has(id));
  const unplanned = taskIds.filter((id) => !rows.has(id));
  const open = new Set(project.milestones.filter((m) => m.state === "approved" || m.state === "in_progress").map((m) => m.id));
  const blocked = planned.filter((id) => !open.has(rows.get(id)!.milestoneId));
  if (blocked.length > 0) {
    const milestones = [...new Set(blocked.map((id) => rows.get(id)!.milestoneId))];
    const current = [...open][0];
    return {
      kind: "refuse",
      reason: "milestone-not-approved",
      message: `Task${blocked.length === 1 ? "" : "s"} ${blocked.join(", ")} belong${blocked.length === 1 ? "s" : ""} to milestone ${milestones.join(", ")}, which is not approved yet. ${
        current === undefined ? "No milestone is open: reply to the person." : `Delegate only milestone ${current}'s tasks; when it is done, report it with project.milestone and reply.`
      }`,
    };
  }
  const milestoneId = planned.length === 0 ? null : rows.get(planned[0]!)!.milestoneId;
  return { kind: "admit", milestoneId, planned, unplanned };
}

/**
 * Whether the person's plan approval stands for this fan-out's own
 * prompt: every task is a row of the plan, runs on the worker the row
 * names (`workerOf`: the resolved leg's member ref), and the write scope
 * stays inside what the plan was approved for (`approvedScope`: the
 * session's folder). Anything else — a new task, another worker, a write
 * elsewhere — asks as before.
 */
export function planCoversFanout(
  rows: readonly AssignmentRow[],
  taskIds: readonly string[],
  workerOf: (taskId: string) => string,
  writeScope: readonly string[],
  approvedScope: readonly string[],
): boolean {
  if (taskIds.length === 0) return false;
  const byTask = new Map(rows.map((r) => [r.taskId, r]));
  for (const id of taskIds) {
    const row = byTask.get(id);
    if (row === undefined || row.worker !== workerOf(id)) return false;
  }
  const roots = approvedScope.map((dir) => resolvePath(dir));
  return writeScope.every((dir) => roots.some((root) => isInside(root, resolvePath(dir))));
}
