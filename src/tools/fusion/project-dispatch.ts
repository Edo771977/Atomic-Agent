import { resolve as resolvePath } from "node:path";

import { isInside } from "../../approval/fanout-scope.js";
import type { ProjectState } from "../../session/session-project.js";
import { sameMember, type DefaultModelOf } from "./member-identity.js";
import type { DelegateContract, ContractCheck } from "./contract.js";
import { checkSpecKey } from "./worker-self-check.js";

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

/** Exact per-task multiset: verify spec identity plus proof metadata and negative input. */
export function plannedCheckMismatch(project: ProjectState | undefined, taskIds: readonly string[], contract: DelegateContract | undefined): string | null {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
    return JSON.stringify(value) ?? "null";
  };
  const key = (c: ContractCheck): string => canonical({ spec: checkSpecKey(c), negative: c.negative ?? null, criteria: [...(c.criteria ?? [])].sort(), judge: c.judge ?? null });
  for (const row of project?.plan?.rows ?? []) {
    if (!taskIds.includes(row.taskId) || (row.checks?.length ?? 0) === 0) continue;
    const planned = row.checks!.map(key).sort();
    const actual = (contract?.checks ?? []).filter((c) => c.task === row.taskId).map(key).sort();
    if (canonical(planned) !== canonical(actual)) return `Task ${row.taskId}'s contract checks differ from its approved plan checks (including negative controls). Update the plan with project.plan and obtain approval before changing these checks.`;
  }
  return null;
}

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
 * prompt: the plan is approved (and, when drafted after outside content,
 * approved with that warning shown), every task is a row of the plan in
 * the milestone now approved or in progress, runs on the worker the row
 * names (`workerOf`: the resolved leg's member ref), is reviewed by the
 * reviewer the row names (`reviewerOf`: the member ref that would review
 * it, null for no review; issue #74), and the write scope stays inside
 * what the plan was approved for (`approvedScope`: the session's folder).
 * Anything else — a new task, another milestone's, another worker or
 * reviewer, a write elsewhere — asks as before. Workers and reviewers are
 * compared by identity (`sameMember`, issue #98): `codex-cli:default` and
 * the provider's resolved default model (`defaultModelOf`) are one member.
 */
export function planCoversFanout(
  project: ProjectState,
  taskIds: readonly string[],
  workerOf: (taskId: string) => string,
  reviewerOf: (taskId: string) => string | null,
  writeScope: readonly string[],
  approvedScope: readonly string[],
  defaultModelOf?: DefaultModelOf,
): boolean {
  return planCoverageGap(project, taskIds, workerOf, reviewerOf, writeScope, approvedScope, defaultModelOf) === undefined;
}

/**
 * Why the approved plan does not stand for this fan-out (issue #104),
 * the first reason {@link planCoversFanout} finds; undefined when it does.
 * The director reads it when the fan-out then could not be approved, so
 * it can send the task as its row says instead.
 */
export function planCoverageGap(
  project: ProjectState,
  taskIds: readonly string[],
  workerOf: (taskId: string) => string,
  reviewerOf: (taskId: string) => string | null,
  writeScope: readonly string[],
  approvedScope: readonly string[],
  defaultModelOf?: DefaultModelOf,
): string | undefined {
  const plan = project.plan;
  if (taskIds.length === 0) return "the call has no task";
  if (plan === undefined || plan.status !== "approved") return "the plan is not approved";
  if (plan.draftedAfterUntrusted && plan.approvedWithUntrustedWarning !== true) return "the plan was drafted after outside content and approved without that warning";
  const open = new Set(project.milestones.filter((m) => m.state === "approved" || m.state === "in_progress").map((m) => m.id));
  const byTask = new Map(plan.rows.map((r) => [r.taskId, r]));
  for (const id of taskIds) {
    const row = byTask.get(id);
    if (row === undefined) return `task ${id} is not a row of the plan`;
    if (!open.has(row.milestoneId)) return `task ${id}'s milestone ${row.milestoneId} is not open`;
    const worker = workerOf(id);
    if (!sameMember(row.worker, worker, defaultModelOf)) return `task ${id} would run on ${worker}, but its plan row names ${row.worker}`;
    const reviewer = reviewerOf(id);
    if (!sameMember(row.reviewer, reviewer, defaultModelOf)) return `task ${id} would be reviewed by ${reviewer ?? "nobody"}, but its plan row names ${row.reviewer ?? "no review"}`;
  }
  const roots = approvedScope.map((dir) => resolvePath(dir));
  const outside = writeScope.find((dir) => !roots.some((root) => isInside(root, resolvePath(dir))));
  return outside === undefined ? undefined : `the call writes in ${outside}, outside the folder the plan was approved for`;
}
