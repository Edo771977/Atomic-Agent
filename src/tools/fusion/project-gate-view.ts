import {
  allowedProjectVerdicts,
  decisionStatusOf,
  finishedCitationsOf,
  gateVersion,
  planDecisionsOf,
  projectExpectation,
  planCheckData,
  planReviewFactsOf,
  planReviewPersonCalls,
  type ProjectState,
} from "../../session/session-project.js";
import { describeViolation, type PlanEstimate, type PlanViolation } from "./project-estimate.js";
import type { ProjectGateView, ProjectGateViolation, ProjectGateViolationKind } from "../../session/project-gate-view.js";
import { evaluatePlanChecks, planCheckHint, type PlanCheckOptions } from "./plan-checks.js";
import { effectivePlanReview, planReviewFresh, planReviewGate } from "./plan-review-record.js";
import { seedHint } from "../../session/project-gate-text.js";
import { backlogStateOf, backlogTakenIn, openBacklog, openSeeds, promotedForPlan, staleBacklogCalls } from "../../session/project-backlog.js";

/**
 * Builds the {@link ProjectGateView} every surface draws (issue #39). The
 * types live in `session/project-gate-view.ts` so surfaces can import
 * them; this file only fills them, pure.
 */

// The view's violation kinds must stay the estimator's.
type _SameKinds = [PlanViolation["kind"]] extends [ProjectGateViolationKind]
  ? [ProjectGateViolationKind] extends [PlanViolation["kind"]] ? true : never
  : never;
const _sameKinds: _SameKinds = true;
void _sameKinds;

export interface ProjectGateViewInput {
  /** Same explicit runtime policy as the decision fold; never read from the author file. */
  planChecks?: PlanCheckOptions;
  sessionId: string;
  project: ProjectState;
  /** `estimatePlan` of the plan's rows with live limits; null without a plan. */
  estimate: PlanEstimate | null;
  /** The members the person may pick, in config order. */
  selectable: { workers: readonly string[]; reviewers: readonly string[] };
  /** Whether `llm.runMode.fusion.team.reviewers` names anyone; absent: whether any reviewer is selectable. */
  reviewersConfigured?: boolean;
  /**
   * Whether the team names a member besides the one worker (another
   * worker, or any reviewer), reachable now or not; absent: as
   * `reviewersConfigured`. Picks which hint explains a plan with nothing
   * to choose.
   */
  otherMembersConfigured?: boolean;
  /**
   * Issue #118: whether a plan reviewer is configured now (`team.planReviewer`
   * or any `team.reviewers`); absent: whether the plan holds a review.
   */
  planReviewerConfigured?: boolean;
}

/** The plan gate's hint when the team names no reviewers (issue #54). */
export const NO_REVIEWERS_HINT = "no reviewers configured: add llm.runMode.fusion.team.reviewers to have each task reviewed";
/** The plan gate's hint when "edit rows" would offer nothing to choose (issue #54). */
export const ONE_WORKER_HINT = "only one worker available: configure llm.runMode.fusion.team to choose";
/** The same, when the team names other members but none can answer now (issue #54). */
export const NONE_REACHABLE_HINT = "no other team member is reachable now: the rows keep their worker";

/** The plan gate's hint for a milestone the draft starts over on new work, its earlier result in history (issue #77). */
export const verdictResetHint = (title: string): string => `verdict reset: ${title}`;

/** The plan gate's hint for a milestone that kept its verdict but lost its criteria evidence to history (issue #83). */
export const evidenceRetiredHint = (title: string): string => `evidence retired: ${title}`;

/** The milestone gate's hint for a criterion verified with reservations (issue #110). */
export const verifiedWithReservationsHint = (id: string, reservation: string): string => `verified with reservations: ${id} (${reservation})`;

export { seedHint };

/** The plan gate's hint for an item the person promoted (issue #111). */
export const promotedHint = (id: string, title: string): string => `promoted from the backlog: ${id} "${title}": check this plan takes it in before approving`;
/** The plan gate's hint for a promoted item the person deferred (issue #146). */
export const deferredHint = (id: string, title: string): string => `promoted from the backlog, deferred by you: ${id} "${title}": this plan need not take it in; set it active again to require it`;

/** The gate card's payload. Pure. */
/** Issue #109: the hint at a gate whose content changed outside Atomic Agent. */
export const CHANGED_OUTSIDE_HINT =
  "This changed outside Atomic Agent since your last decision (project.json was edited, or the project came from another machine): read it before approving.";

export function projectGateView(input: ProjectGateViewInput): ProjectGateView {
  const { project, estimate } = input;
  const plan = project.plan;
  const byMilestone = new Map((estimate?.milestones ?? []).map((m) => [m.id, m]));
  const violations: ProjectGateViolation[] = (estimate?.violations ?? [])
    .map((v) => ({
      kind: v.kind,
      severity: v.severity,
      message: describeViolation(v),
      ...("milestoneId" in v ? { milestoneId: v.milestoneId } : {}),
      ...("taskId" in v ? { taskId: v.taskId } : {}),
    }))
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "hard" ? -1 : 1));
  const rows = (plan?.rows ?? []).map((row) => ({
    ...row,
    selectableWorkers: [...input.selectable.workers],
    selectableReviewers: input.selectable.reviewers.filter((r) => r !== row.worker),
  }));
  // Nothing to choose: every row's only worker is its own, no reviewer.
  const editable = rows.some((row) =>
    row.selectableReviewers.length > 0 || row.selectableWorkers.some((w) => w !== row.worker));
  const hints: string[] = [];
  // Issue #98: a milestone's open reviews, one line each, wherever its gate is open.
  if (project.gate.kind === "milestone") {
    const id = project.gate.id;
    const milestone = project.milestones.find((m) => m.id === id);
    for (const block of milestone?.reviewBlocks ?? []) {
      hints.push(`review open: ${block.taskId} (${block.reason})`);
    }
    // Issue #110: green only on checks that may pass on the wrong thing.
    for (const fact of milestone?.criteriaFacts ?? []) {
      if (fact.state === "passed" && fact.reservation !== undefined) hints.push(verifiedWithReservationsHint(fact.id, fact.reservation));
    }
  }
  if (project.gate.kind === "plan" && plan !== undefined) {
    const criteria = project.approvedCriteria ?? (project.brief?.status === "approved" ? project.brief.successCriteria : []);
    const planChecks = evaluatePlanChecks(plan.rows, criteria, { ...input.planChecks, ...planCheckData(project, plan) }, planDecisionsOf(project), finishedCitationsOf(project.milestones));
    hints.push(...planChecks.map(planCheckHint));
    // Issue #118: the plan reviewer's summary and every dimension that is not a pass (facts recomputed now).
    hints.push(...planReviewGate(plan, project.milestones.map((m) => m.id), { criteria, planChecks, personCalls: planReviewPersonCalls(project) }, input.planReviewerConfigured ?? plan.review !== undefined).hints);
    if (!(input.reviewersConfigured ?? input.selectable.reviewers.length > 0)) hints.push(NO_REVIEWERS_HINT);
    if (!editable) {
      const others = input.otherMembersConfigured ?? input.reviewersConfigured ?? false;
      hints.push(others ? NONE_REACHABLE_HINT : ONE_WORKER_HINT);
    }
    // Issue #77: the person approves a plan that starts these over.
    for (const id of plan.verdictResets ?? []) {
      const m = project.milestones.find((x) => x.id === id);
      if (m !== undefined) hints.push(verdictResetHint(m.title));
    }
    // Issue #83: these keep their verdict, but their criteria evidence went to history.
    for (const id of plan.evidenceRetired ?? []) {
      const m = project.milestones.find((x) => x.id === id);
      if (m !== undefined) hints.push(evidenceRetiredHint(m.title));
    }
  }
  // Issue #111: the seeds at each plan and milestone gate; promoted items at the plan gate; open items at the close.
  if (project.cancelledAt === undefined && (project.gate.kind === "plan" || project.gate.kind === "milestone")) {
    for (const s of openSeeds(project)) hints.push(seedHint(s.id, s.title, s.condition!));
  }
  if (project.gate.kind === "plan") {
    for (const b of promotedForPlan(project)) hints.push(project.backlogCalls?.[b.id]?.deferred === true ? deferredHint(b.id, b.title) : promotedHint(b.id, b.title));
    // Review of #111: a call bound to text that changed, or to an item removed, outside Atomic Agent.
    for (const s of staleBacklogCalls(project)) {
      hints.push(s.reason === "removed"
        ? `promoted item ${s.id} was removed outside Atomic Agent`
        : `backlog item ${s.id} changed since you ${s.state} it: it reads open again; ${s.state === "promoted" ? "promote" : "drop"} it again if you still want it`);
    }
  }
  const expectation = projectExpectation(project);
  if (expectation.kind === "complete" && expectation.openBacklog !== undefined) {
    const n = expectation.openBacklog;
    hints.push(`complete with ${n} backlog item${n === 1 ? "" : "s"} open: ${openBacklog(project).map((b) => `${b.id} ${b.title}`).join(", ")}`);
  }
  // Issue #146: promoted items no run took in are said too, never counted as done.
  if (expectation.kind === "complete" && expectation.promotedNotDone !== undefined) {
    const n = expectation.promotedNotDone;
    hints.push(`complete with ${n} promoted backlog item${n === 1 ? "" : "s"} not done: ${promotedForPlan(project).map((b) => `${b.id} ${b.title}`).join(", ")}`);
  }
  // A call on an item removed outside Atomic Agent keeps the backlog in view, so the card can say so
  // even when project.json holds no item any more.
  const backlog = (project.backlog ?? []).length === 0 && staleBacklogCalls(project).length === 0
    ? undefined
    : {
        open: openBacklog(project).length,
        seeds: openSeeds(project).map((b) => ({ id: b.id, title: b.title, condition: b.condition! })),
        promoted: promotedForPlan(project).map((b) => ({ id: b.id, title: b.title, ...(project.backlogCalls?.[b.id]?.deferred === true ? { deferred: true as const } : {}) })),
        stale: staleBacklogCalls(project),
        items: (project.backlog ?? []).map((b) => {
          const promoted = backlogStateOf(project, b.id) === "promoted";
          const plannedIn = promoted ? backlogTakenIn(project, b.id) : undefined;
          const deferred = promoted && plannedIn === undefined && project.backlogCalls?.[b.id]?.deferred === true;
          return { ...b, ...(b.origin === undefined ? {} : { origin: { ...b.origin } }), state: backlogStateOf(project, b.id), ...(plannedIn === undefined ? {} : { plannedIn }), ...(deferred ? { deferred: true as const } : {}) };
        }),
      };
  // Issue #109: what waits changed outside Atomic Agent since the person decided it.
  const gateLabel = project.gate.kind === "milestone" ? `milestone:${project.gate.id}` : project.gate.kind;
  const changedOutside = project.gate.kind !== "none" && (project.changedOutside ?? []).includes(gateLabel);
  if (changedOutside) hints.unshift(CHANGED_OUTSIDE_HINT);
  const decisions = (project.brief?.decisions ?? []).map((d) => ({
    id: d.id,
    text: d.text,
    status: decisionStatusOf(project, d.id),
    citedBy: (plan?.rows ?? []).filter((r) => (r.decisions ?? []).includes(d.id)).map((r) => r.taskId),
  }));
  const review = project.gate.kind === "plan" ? plan?.review : undefined;
  const missingReview = project.gate.kind === "plan" && plan !== undefined && review === undefined && input.planReviewerConfigured === true;
  return {
    ...(missingReview ? { planReview: { outcome: "missing" as const, reviewer: null, results: [], round: 0, stale: false, autoApprovable: false } } : {}),
    ...(review === undefined
      ? {}
      : {
          planReview: {
            outcome: review.outcome,
            reviewer: review.reviewer,
            results: (effectivePlanReview(plan, project.milestones.map((m) => m.id), planReviewFactsOf(project, input.planChecks)) ?? review.results).map((r) => ({ ...r, taskIds: [...r.taskIds] })),
            ...(review.reason === undefined ? {} : { reason: review.reason }),
            round: review.round,
            stale: !planReviewFresh(plan!, project.milestones.map((m) => m.id), planReviewPersonCalls(project)),
            autoApprovable: planReviewGate(plan, project.milestones.map((m) => m.id), planReviewFactsOf(project, input.planChecks), input.planReviewerConfigured ?? true).autoApprovable,
          },
        }),
    ...(changedOutside ? { changedOutside: true as const } : {}),
    ...(decisions.length === 0 ? {} : { decisions }),
    ...(backlog === undefined ? {} : { backlog }),
    schema: 1,
    sessionId: input.sessionId,
    gate: project.gate,
    version: gateVersion(project),
    allowedVerdicts: project.cancelledAt !== undefined ? [] : allowedProjectVerdicts(project.gate, project),
    expectation,
    cancelled: project.cancelledAt !== undefined,
    brief:
      project.brief === undefined
        ? null
        : { ...project.brief, successCriteria: project.brief.successCriteria.map((c) => c.text), criteria: project.brief.successCriteria.map((c) => ({ ...c })) },
    plan:
      plan === undefined
        ? null
        : {
            status: plan.status,
            detail: plan.detail,
            version: plan.version,
            draftedAfterUntrusted: plan.draftedAfterUntrusted,
            rows,
            totals: estimate?.totals ?? plan.totals,
            editable,
          },
    milestones: project.milestones.map((m) => ({
      ...m,
      estCostUsd: byMilestone.get(m.id)?.costUsd ?? null,
      estMs: byMilestone.get(m.id)?.ms ?? null,
    })),
    violations,
    hints,
  };
}

/** Whether a surface should be told: the gate or the number it decides against moved. */
export function projectGateChanged(before: ProjectState | undefined, after: ProjectState | undefined): boolean {
  if (before === after) return false;
  if (before === undefined || after === undefined) return true;
  const a = before.gate;
  const b = after.gate;
  return (
    a.kind !== b.kind ||
    (a.kind === "milestone" && b.kind === "milestone" && a.id !== b.id) ||
    gateVersion(before) !== gateVersion(after) ||
    before.cancelledAt !== after.cancelledAt
  );
}
