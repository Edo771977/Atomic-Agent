import type { RuntimeProjectDecisionResult } from "../project-decision-contract.js";
import {
  applyProjectDecision,
  withProject,
  type AssignmentRow,
  type ProjectDecision,
  type ProjectState,
} from "../../session/session-project.js";
import type { SessionState } from "../../session/session-state.js";
import { LIVE_SESSION_STATUSES } from "../../session/session-retention.js";
import { parseTeamMember, type TeamMember } from "../../llm/run-mode/fusion-team.js";
import type { ModelTier } from "../../llm/provider/presets/model-tiers.js";
import {
  acceptanceRate,
  cheaperVariant,
  estimatePlan,
  estimateRow,
  qualityVariant,
  type PlanConstraints,
  type PlanEstimate,
  type VariantContext,
  withRowEstimate,
} from "../../tools/fusion/project-estimate.js";
import type { ProjectGateView } from "../../session/project-gate-view.js";
import { projectGateChanged, projectGateView } from "../../tools/fusion/project-gate-view.js";
import type { ProjectPlanContext } from "../../tools/fusion/project-tools.js";
import type { AtomicAgentConfig } from "../../config/index.js";
import { resolveLlmConfig } from "../../llm/provider/index.js";
import { isLocalServerUrl } from "../../llm/provider/openai/local-server-url.js";
import { teamMembers, teamStrengthOf } from "../../llm/run-mode/fusion-team.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import { resolveModelPricingFor } from "../resolve-model-pricing.js";
import { teamContextFromConfig } from "../../tools/fusion/team-routing.js";
import { projectPlanContextFrom } from "../../tools/fusion/project-plan-context.js";
import { readRoutingHistory } from "../../tools/fusion/measured-routing.js";
import { outcomeLogPath } from "../../tools/fusion/outcome-log.js";
import { isCodexCliProvider } from "../session-director.js";

/**
 * The person's side of the fusion project (issue #39): read the gate a
 * surface draws, decide on it between turns, and tell the surfaces when
 * the gate moves. The estimates, variants and hard caps are recomputed
 * here from the live team, prices, policy and limits on every call, so a
 * card shows what an approval would commit to now, not when it was drafted.
 */

export type { RuntimeProjectDecisionError, RuntimeProjectDecisionResult } from "../project-decision-contract.js";

/** The `project_gate` agent/runtime event: the gate (or the number it decides against) moved. */
export interface ProjectGateEvent {
  type: "project_gate";
  view: ProjectGateView;
}

/** What the live estimates read for one session (built from config, team, policy and limits). */
export interface LiveProjectInputs {
  /** `project.plan`'s context: members, history, prices, speeds. */
  plan: ProjectPlanContext;
  /** Limits for `estimatePlan`, minus `nextMilestoneId` (set here per gate). */
  constraints: Omit<PlanConstraints, "nextMilestoneId">;
  /** The member's tier (`teamStrengthOf`); null when it holds none. */
  strength: (member: TeamMember) => ModelTier | null;
  isLocal: (member: TeamMember) => boolean;
  /** Whether `llm.runMode.fusion.team.reviewers` names anyone (the gate's hint, issue #54). */
  reviewersConfigured?: boolean;
  /** Whether the team names more than one worker or any reviewer (the gate's hint wording). */
  otherMembersConfigured?: boolean;
}

export interface LiveProjectInputsSource {
  config: AtomicAgentConfig;
  /** Whether a team member can answer now (`teamMemberReachable`). */
  reachable?: (member: TeamMember) => boolean;
  /** The folder's provider policy for the session (or the turn's frame). */
  allows: (providerId: string) => boolean;
  mode: Pick<ResolvedRunMode, "workerProviderId" | "workerModel" | "turnBudgetUsd">;
  currentWorker?: TeamMember | null;
  /** The session's reviewer (issue #71); `"none"`: no review in this chat. */
  currentReviewer?: TeamMember | "none" | null;
  /** The chat's provider policy is restricted: no reviewer whose CLI keeps its tools on (issue #71). */
  restricted?: boolean;
  /** The local leg's measured speed (`measuredTokensPerSecond`). */
  tokensPerSecond: () => number | null;
  /** What is left of today's limit; null: none. */
  dailyRemainingUsd: number | null;
  /** The local server's slots, once observed. */
  localSlots?: number | null;
  now?: number;
}

/**
 * The live inputs from config, team, policy and limits: the same team
 * binding `project.plan` and `fusion.delegate` use, the outcome history
 * and prices for estimates, and the plan's limits.
 */
export function liveProjectInputsFrom(source: LiveProjectInputsSource): LiveProjectInputs {
  const resolved = resolveLlmConfig(source.config);
  const fusion = resolved.runMode?.fusion;
  const entryOf = (providerId: string) => resolved.providers.find((p) => p.id === providerId);
  const localProvider = (providerId: string): boolean => {
    const entry = entryOf(providerId);
    return entry !== undefined && (entry.kind === "llama-server" || isLocalServerUrl(entry.baseUrl ?? entry.url));
  };
  const providerOf = (ref: string): string => (ref.includes(":") ? ref.slice(0, ref.indexOf(":")) : ref);
  const team = teamContextFromConfig(source.config, source.reachable);
  const plan = projectPlanContextFrom({
    team,
    ...(fusion?.judge === undefined ? {} : { judge: fusion.judge }),
    allows: source.allows,
    workerLeg:
      source.mode.workerProviderId === null
        ? null
        : { providerId: source.mode.workerProviderId, model: source.mode.workerModel ?? source.mode.workerProviderId },
    ...(source.currentWorker === undefined ? {} : { currentWorker: source.currentWorker }),
    ...(source.currentReviewer === undefined ? {} : { currentReviewer: source.currentReviewer }),
    ...(source.restricted === undefined ? {} : { restricted: source.restricted }),
    cliToolsStayOn: (providerId) => isCodexCliProvider(resolved, providerId),
    records: readRoutingHistory(outcomeLogPath(source.config.paths.stateDir)),
    pricing: (providerId, model) => resolveModelPricingFor(resolved, model, providerId)?.pricing,
    isLocal: localProvider,
    tokensPerSecond: source.tokensPerSecond,
    ...(fusion?.measuredRouting === undefined ? {} : { measured: fusion.measuredRouting }),
    ...(fusion?.project === undefined ? {} : { projectConfig: fusion.project }),
    ...(source.now === undefined ? {} : { now: source.now }),
  });
  return {
    plan,
    constraints: {
      isLocal: (ref) => localProvider(providerOf(ref)),
      ...(source.mode.turnBudgetUsd === undefined ? {} : { turnBudgetUsd: source.mode.turnBudgetUsd }),
      dailyRemainingUsd: source.dailyRemainingUsd,
      ...(source.localSlots === undefined || source.localSlots === null ? {} : { localSlots: source.localSlots }),
      allows: source.allows,
    },
    strength: teamStrengthOf(resolved.providers),
    isLocal: (member) => localProvider(member.providerId),
    reviewersConfigured: team !== undefined && teamMembers(team.team, "reviewers").length > 0,
    otherMembersConfigured: team !== undefined &&
      (teamMembers(team.team, "workers").length > 1 || teamMembers(team.team, "reviewers").length > 0),
  };
}

export interface RuntimeProjectDeps {
  loadSession: (sessionId: string) => SessionState | null;
  saveSession: (session: SessionState) => void;
  /** A turn is queued or running on the session (`TurnController.isBusy`). */
  isBusy: (sessionId: string) => boolean;
  /**
   * A live stored status on the session is a turn a live process runs
   * (`SessionStore.liveTurnElsewhere`); absent, every live status counts.
   */
  liveTurnElsewhere?: (sessionId: string) => boolean;
  liveInputs: (session: SessionState) => LiveProjectInputs;
  emit: (sessionId: string, event: ProjectGateEvent) => void;
  now?: () => number;
}

export interface RuntimeProject {
  /** The gate view of the session's project; null without a session or project. */
  projectState(sessionId: string): ProjectGateView | null;
  /** The person's decision; between turns only. Persists and emits `project_gate` on success. */
  projectDecision(sessionId: string, decision: ProjectDecision): RuntimeProjectDecisionResult;
  /** After a turn: emit `project_gate` when the turn moved the gate. */
  noteTurnEnd(sessionId: string, before: ProjectState | undefined, after: ProjectState | undefined): void;
}

/**
 * The milestone whose cost the daily limit must hold: the failed one at
 * its own gate (it runs again), else the first not finished — the one an
 * approval would start.
 */
export function nextMilestoneOf(project: ProjectState): string | undefined {
  const gate = project.gate;
  if (gate.kind === "milestone") {
    const at = project.milestones.find((m) => m.id === gate.id);
    if (at?.state === "failed") return at.id;
    return project.milestones.find((m) => m.id !== gate.id && (m.state === "planned" || m.state === "approved"))?.id;
  }
  return project.milestones.find((m) => m.state === "planned" || m.state === "approved" || m.state === "in_progress")?.id;
}

function estimateFor(project: ProjectState, inputs: LiveProjectInputs, rows?: readonly AssignmentRow[]): PlanEstimate | null {
  const plan = project.plan;
  if (plan === undefined) return null;
  const next = nextMilestoneOf(project);
  return estimatePlan(rows ?? plan.rows, { ...inputs.constraints, ...(next === undefined ? {} : { nextMilestoneId: next }) });
}

/** Re-estimate rows the person edited, or build a variant, from the live context. Pure over `inputs`. */
export function liveReplan(inputs: LiveProjectInputs): (rows: readonly AssignmentRow[], verdict: "edit" | "cheaper" | "quality") => AssignmentRow[] {
  const ctx = inputs.plan;
  const estimate = (member: TeamMember) =>
    estimateRow(member, null, ctx.records, ctx.pricing(member), {
      minSamples: ctx.minSamples,
      days: ctx.days,
      ...(ctx.now === undefined ? {} : { now: ctx.now }),
      tokensPerSecond: ctx.tokensPerSecond(member),
      local: ctx.isLocal?.(member) ?? false,
    });
  const variant: VariantContext = {
    members: ctx.workers,
    strength: inputs.strength,
    isLocal: inputs.isLocal,
    estimate: (member) => estimate(member),
    acceptance: (member) => acceptanceRate(ctx.records, member, { days: ctx.days, ...(ctx.now === undefined ? {} : { now: ctx.now }) }),
    reviewerFor: (worker) => (ctx.reviewOn ? ctx.reviewerFor(worker) : null),
    reviewers: ctx.reviewers,
  };
  return (rows, verdict) => {
    if (verdict === "cheaper") return cheaperVariant(rows, variant);
    if (verdict === "quality") return qualityVariant(rows, variant);
    return rows.map((row) => {
      const member = parseTeamMember(row.worker);
      if (member === null) return row;
      const est = estimate(member);
      return withRowEstimate(row, est, `edited by the person; ${est.reason}`);
    });
  };
}

export function createRuntimeProject(deps: RuntimeProjectDeps): RuntimeProject {
  const now = deps.now ?? Date.now;
  const view = (session: SessionState, project: ProjectState): ProjectGateView => {
    const inputs = deps.liveInputs(session);
    return projectGateView({
      sessionId: session.id,
      project,
      estimate: estimateFor(project, inputs),
      selectable: {
        workers: inputs.plan.workers.map((m) => m.ref),
        reviewers: inputs.plan.reviewers.map((m) => m.ref),
      },
      ...(inputs.reviewersConfigured === undefined ? {} : { reviewersConfigured: inputs.reviewersConfigured }),
      ...(inputs.otherMembersConfigured === undefined ? {} : { otherMembersConfigured: inputs.otherMembersConfigured }),
    });
  };
  return {
    projectState(sessionId) {
      const session = deps.loadSession(sessionId);
      if (session?.project === undefined) return null;
      return view(session, session.project);
    },
    projectDecision(sessionId, decision) {
      // Between turns only: a running turn's save would put the old project back.
      const turnRunning = { ok: false as const, error: { code: "turn-running" as const, message: "Wait for the current work to finish, then decide." } };
      if (deps.isBusy(sessionId)) return turnRunning;
      const session = deps.loadSession(sessionId);
      if (session === null) return { ok: false, error: { code: "no-session", message: `There is no session ${sessionId}.` } };
      // Issue #74: a turn another process on the state dir runs shows only in the stored status.
      // A status a crashed process left behind does not hold the gate shut (issue #74 review).
      if (LIVE_SESSION_STATUSES.includes(session.status) && (deps.liveTurnElsewhere?.(sessionId) ?? true)) return turnRunning;
      const project = session.project;
      const inputs = deps.liveInputs(session);
      const estimate = project === undefined ? null : estimateFor(project, inputs);
      const result = applyProjectDecision(project, decision, {
        now: now(),
        hardViolations: estimate?.hardViolations ?? [],
        replan: liveReplan(inputs),
      });
      if (!result.ok) return result;
      const saved = withProject(session, result.project);
      deps.saveSession(saved);
      const next = view(saved, result.project);
      deps.emit(sessionId, { type: "project_gate", view: next });
      return { ok: true, project: result.project, view: next };
    },
    noteTurnEnd(sessionId, before, after) {
      if (after === undefined || !projectGateChanged(before, after)) return;
      const session = deps.loadSession(sessionId);
      if (session === null) return;
      deps.emit(sessionId, { type: "project_gate", view: view(session, after) });
    },
  };
}
