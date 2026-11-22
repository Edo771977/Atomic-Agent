import { createHash } from "node:crypto";

import type { AssignmentRow, ProjectBriefDecision, ProjectCriterion, ProjectDecisionStatus, ProjectReviewBlock } from "../../session/session-project.js";
import { lintContractCheck } from "./contract-check-lint.js";

export type PlanCheckDimension = "check-lint" | "criteria-coverage" | "verifiability" | "decision-coverage" | "backlog-coverage" | "lesson-coverage" | "references";
export interface PlanCheckResult {
  dimension: PlanCheckDimension;
  verdict: "pass" | "warn" | "fail";
  detail: string;
  taskIds: string[];
}
export interface PlanCheckOptions {
  /** Caller's policy: promote warnings to failures for these dimensions (never `references`). */
  blockingDimensions?: readonly PlanCheckDimension[];
  /** The plan's stored references record (issue #120, `ProjectPlan.referenceCheck`); absent: no such result. */
  references?: PlanReferenceRecord;
  /**
   * Issue #146: the backlog as the record has it, for `backlog-coverage`
   * (`backlogCheckOptions` in `session-project.ts`); absent: no such result.
   */
  backlog?: PlanBacklog;
  lessons?: PlanLessonCoverage[];
  activeLessonIds?: readonly string[];
  staleLessonIds?: readonly string[];
  undeclaredLessonTasks?: readonly string[];
}

export interface PlanLessonCoverage {
  id: string;
  title: string;
  deferred: boolean;
  citedBy: string[];
  missingFrom: string[];
}

function lessonCoverage(rows: readonly AssignmentRow[], options: PlanCheckOptions): PlanCheckResult[] {
  if (options.activeLessonIds === undefined) return [];
  const results: PlanCheckResult[] = [];
  const active = new Set(options.activeLessonIds);
  for (const id of options.staleLessonIds ?? []) results.push({
    dimension: "lesson-coverage", verdict: "warn", taskIds: [],
    detail: `Approved lesson ${id} changed or was removed. Approve it again or retire it.`,
  });
  for (const row of rows) {
    const stray = (row.lessons ?? []).filter((id) => !active.has(id));
    if (stray.length > 0) results.push({
      dimension: "lesson-coverage", verdict: "warn", taskIds: [row.taskId],
      detail: `Task ${row.taskId} cites inactive or unknown lessons: ${stray.join(", ")}.`,
    });
  }
  for (const taskId of options.undeclaredLessonTasks ?? []) results.push({
    dimension: "lesson-coverage", verdict: "warn", taskIds: [taskId],
    detail: `Task ${taskId} has no declared file or check paths for scoped binding lessons.`,
  });
  const lessons = options.lessons ?? [];
  const missing = lessons.filter((lesson) => !lesson.deferred && lesson.missingFrom.length > 0);
  if (missing.length > 0) {
    results.push({
      dimension: "lesson-coverage", verdict: "fail",
      detail: `Cite binding lessons on each affected task: ${missing.map((lesson) => `${lesson.id} (${lesson.missingFrom.join(", ")})`).join(", ")}. The person can defer a lesson at the plan gate.`,
      taskIds: [...new Set(missing.flatMap((lesson) => lesson.missingFrom))],
    });
  } else if (lessons.length > 0) {
    results.push({ dimension: "lesson-coverage", verdict: "pass", detail: "Every required lesson is cited by each affected task.", taskIds: [] });
  }
  return results;
}

/** A backlog item the person promoted that no approved plan has taken in yet (issue #146). */
export interface PlanBacklogItem {
  id: string;
  title: string;
  /** The person deferred it at the plan gate: still promoted, not required in this plan. */
  deferred: boolean;
}

/** What `backlog-coverage` reads: the waiting promoted items and every backlog item id. */
export interface PlanBacklog {
  items: readonly PlanBacklogItem[];
  known: readonly string[];
  /** Milestones whose work was dispatched: a citation on their tasks covers nothing. */
  started: readonly string[];
}

/** A decision of the last approved brief with the person's status for it (issue #112). */
export interface PlanDecision extends ProjectBriefDecision {
  status: ProjectDecisionStatus;
}

/**
 * Issue #112: every `active` decision must be cited by a plan task's
 * `decisions`; one that is not fails, whatever the caller's policy (the
 * person can defer it at the plan gate). Absent when the brief has none.
 */
function decisionCoverage(rows: readonly AssignmentRow[], decisions: readonly PlanDecision[], finished: ReadonlyMap<string, readonly string[]>): PlanCheckResult[] {
  // A citation of an id that is no decision is a slip, not a block: warn, naming it per task.
  const known = new Set(decisions.map((d) => d.id));
  const strays = rows.flatMap((r) => {
    const unknown = (r.decisions ?? []).filter((id) => !known.has(id));
    return unknown.length === 0 ? [] : [{ taskId: r.taskId, unknown }];
  });
  const stray: PlanCheckResult[] = strays.length === 0 ? [] : [{
    dimension: "decision-coverage",
    verdict: "warn",
    detail: `Tasks cite ids that are no decision of the approved brief: ${strays.map((s) => `${s.taskId} (${s.unknown.join(", ")})`).join(", ")}.`,
    taskIds: strays.map((s) => s.taskId),
  }];
  if (decisions.length === 0) return stray;
  // A done or reviewed milestone's task counts only for what it cited when it ran (its snapshot):
  // a citation added to it since names work that will not run again.
  const cited = new Set([
    ...rows.filter((r) => !finished.has(r.milestoneId)).flatMap((r) => r.decisions ?? []),
    ...[...finished.values()].flat(),
  ]);
  const missing = decisions.filter((d) => d.status === "active" && !cited.has(d.id));
  const late = (id: string) => rows
    .filter((r) => finished.has(r.milestoneId) && (r.decisions ?? []).includes(id))
    .map((r) => ` ${r.taskId} is in a finished milestone (${r.milestoneId}); cite ${id} on a task that will run.`)
    .join("");
  const excluded = decisions.filter((d) => d.status !== "active");
  const aside = excluded.length === 0 ? "" : ` Not checked: ${excluded.map((d) => `${d.id} (${d.status})`).join(", ")}.`;
  return [...stray, missing.length === 0
    ? { dimension: "decision-coverage", verdict: "pass", detail: `Every active decision is cited by a plan task.${aside}`, taskIds: [] }
    : { dimension: "decision-coverage", verdict: "fail", detail: `No plan task that will run cites active decisions: ${missing.map((d) => `${d.id} (${d.text})`).join(", ")}. Cite each on a task's decisions, or the person defers it at the plan gate.${missing.map((d) => late(d.id)).join("")}${aside}`, taskIds: [] }];
}

/**
 * Issue #146, the decision rule (#112) for the backlog: every item the
 * person promoted that no approved plan took in must be cited by a task
 * of a milestone not started yet; one that is not fails, whatever the
 * caller's policy (the person can defer it at the plan gate). A started
 * milestone's task never counts: its work was dispatched before the
 * citation (the rule is stricter than #112's for decisions, where only a
 * finished milestone's later citations are ignored). Ids that are no backlog item warn. No result without waiting items
 * or stray ids.
 */
function backlogCoverage(rows: readonly AssignmentRow[], backlog: PlanBacklog): PlanCheckResult[] {
  const started = new Set(backlog.started);
  const known = new Set(backlog.known);
  const strays = rows.flatMap((r) => {
    const unknown = (r.backlog ?? []).filter((id) => !known.has(id));
    return unknown.length === 0 ? [] : [{ taskId: r.taskId, unknown }];
  });
  const stray: PlanCheckResult[] = strays.length === 0 ? [] : [{
    dimension: "backlog-coverage",
    verdict: "warn",
    detail: `Tasks cite ids that are no backlog item: ${strays.map((s) => `${s.taskId} (${s.unknown.join(", ")})`).join(", ")}.`,
    taskIds: strays.map((s) => s.taskId),
  }];
  if (backlog.items.length === 0) return stray;
  const cited = new Set(rows.filter((r) => !started.has(r.milestoneId)).flatMap((r) => r.backlog ?? []));
  const missing = backlog.items.filter((b) => !b.deferred && !cited.has(b.id));
  const late = (id: string) => rows
    .filter((r) => started.has(r.milestoneId) && (r.backlog ?? []).includes(id))
    .map((r) => ` ${r.taskId} is in a milestone that already started (${r.milestoneId}); cite ${id} on a task that will run.`)
    .join("");
  const deferred = backlog.items.filter((b) => b.deferred);
  const aside = deferred.length === 0 ? "" : ` Not required: ${deferred.map((b) => `${b.id} (deferred)`).join(", ")}.`;
  return [...stray, missing.length === 0
    ? { dimension: "backlog-coverage", verdict: "pass", detail: `Every promoted backlog item is cited by a plan task that will run.${aside}`, taskIds: [] }
    : { dimension: "backlog-coverage", verdict: "fail", detail: `No plan task that will run cites promoted backlog items: ${missing.map((b) => `${b.id} (${b.title})`).join(", ")}. Cite each on a task's backlog, or the person defers it at the plan gate.${missing.map((b) => late(b.id)).join("")}${aside}`, taskIds: [] }];
}

/**
 * Static analysis only. Criteria and decisions must come from the last
 * approved brief; `finished` maps each done or reviewed milestone to the
 * decision ids its tasks cited when it ran (`decisionsCited`).
 */
export function evaluatePlanChecks(
  rows: readonly AssignmentRow[],
  criteria: readonly ProjectCriterion[],
  options: PlanCheckOptions = {},
  decisions: readonly PlanDecision[] = [],
  finished: ReadonlyMap<string, readonly string[]> = new Map(),
): PlanCheckResult[] {
  const checked = rows.filter((r) => (r.checks?.length ?? 0) > 0);
  const findings = checked.flatMap((row) => row.checks!.flatMap((check, i) =>
    lintContractCheck(check, i).map((finding) => ({ row, finding }))));
  const lint: PlanCheckResult[] = findings.length === 0
    ? [{ dimension: "check-lint", verdict: "pass", detail: "No static check lint findings.", taskIds: checked.map((r) => r.taskId) }]
    : findings.map(({ row, finding }) => ({ dimension: "check-lint", verdict: finding.severity === "severe" ? "fail" : "warn", detail: `${row.taskId}: ${finding.where} ${finding.message}`, taskIds: [row.taskId] }));
  const covered = new Set(checked.flatMap((r) => r.checks!.flatMap((c) => c.criteria ?? [])));
  const missing = criteria.filter((c) => !covered.has(c.id));
  const bare = checked.length === 0 ? [] : rows.filter((r) => (r.checks?.length ?? 0) === 0).map((r) => r.taskId);
  const results: PlanCheckResult[] = [
    ...lint,
    { dimension: "criteria-coverage", verdict: missing.length === 0 ? "pass" : "warn", detail: missing.length === 0 ? "Every approved criterion is named by a plan check." : `No plan check names approved criteria: ${missing.map((c) => c.id).join(", ")}.`, taskIds: [] },
    { dimension: "verifiability", verdict: bare.length === 0 ? "pass" : "warn", detail: bare.length === 0 ? "No task is missing checks in a plan that uses them." : `Tasks without checks: ${bare.join(", ")}.`, taskIds: bare },
    ...decisionCoverage(rows, decisions, finished),
    ...lessonCoverage(rows, options),
    ...(options.backlog === undefined ? [] : backlogCoverage(rows, options.backlog)),
  ];
  const promoted = results.map((r): PlanCheckResult => r.verdict === "warn" && r.dimension !== "lesson-coverage" && options.blockingDimensions?.includes(r.dimension) ? { ...r, verdict: "fail" } : r);
  // Issue #120: the person decides on what the plan cites; never promoted to a failure.
  return options.references === undefined ? promoted : [...promoted, referencesResult(rows, options.references)];
}

function referencesResult(rows: readonly AssignmentRow[], record: PlanReferenceRecord): PlanCheckResult {
  if (record.basis !== planReferenceBasis(rows)) {
    return { dimension: "references", verdict: "warn", detail: "Not re-checked: the tasks' text or checks changed since the plan's references were read; draft the plan again to check them.", taskIds: [] };
  }
  return { dimension: "references", verdict: record.verdict, detail: record.detail, taskIds: [...record.taskIds] };
}

/**
 * Issue #120: the `references` dimension, computed by the runtime when
 * the plan is drafted (`plan-references.ts`, which reads the project
 * folder) and kept on the plan as a record. `basis` is
 * {@link planReferenceBasis} of the rows it read: a record whose basis no
 * longer matches the rows is reported as not re-checked. Never blocking.
 */
export interface PlanReferenceRecord {
  verdict: "pass" | "warn";
  detail: string;
  taskIds: string[];
  basis: string;
}

/** What the references were read from: each task's id, title and checks. */
export function planReferenceBasis(rows: readonly AssignmentRow[]): string {
  const text = JSON.stringify(rows.map((r) => [r.taskId, r.title, r.checks ?? []]));
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export const REFERENCE_DETAIL_MAX = 4_000;

/** A stored {@link PlanReferenceRecord}, or undefined when malformed (a record only: it never blocks). */
export function readPlanReferenceRecord(raw: unknown): PlanReferenceRecord | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (r.verdict !== "pass" && r.verdict !== "warn") return undefined;
  if (typeof r.detail !== "string" || typeof r.basis !== "string" || !/^[0-9a-f]{16}$/.test(r.basis)) return undefined;
  if (!Array.isArray(r.taskIds) || r.taskIds.length > 200 || !r.taskIds.every((t) => typeof t === "string" && t.length > 0 && t.length <= 64)) return undefined;
  return { verdict: r.verdict, detail: r.detail.slice(0, REFERENCE_DETAIL_MAX), taskIds: [...new Set(r.taskIds as string[])], basis: r.basis };
}

export const planCheckHint = (r: PlanCheckResult): string => `${r.dimension}: ${r.verdict}: ${r.detail}`;

/** Feed failures through the same review-open mechanism as milestone review blocks. */
export function planCheckReviewBlocks(results: readonly PlanCheckResult[]): ProjectReviewBlock[] {
  return results.filter((r) => r.verdict === "fail").flatMap((r) =>
    (r.taskIds.length === 0 ? ["plan"] : r.taskIds).map((taskId) => ({ taskId, reason: planCheckHint(r) })));
}
