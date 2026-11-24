import { getConfig } from "../../config/index.js";
import type { AtomicAgentConfig } from "../../config/index.js";
import type { UserFusionTeamConfig, UserLlmFusionConfig } from "../../config/llm-run-mode-config.js";
import { isLocalServerUrl } from "../../llm/provider/openai/local-server-url.js";
import { resolveLlmConfig } from "../../llm/provider/registry/provider-types.js";
import {
  defaultWorker,
  pickReviewer,
  teamFamilyOf,
  teamStrengthOf,
  teamMembers,
  type TeamFamily,
  type TeamMember,
} from "../../llm/run-mode/fusion-team.js";
import type { ModelTier } from "../../llm/provider/presets/model-tiers.js";
import type { TeamTaskRouting } from "./role-models.js";

/**
 * The fusion team as `fusion.delegate` routes by it (issue #37): which
 * workers a task may name, the worker of a task that names none, the
 * director, and the reviewer (judge) of a task a given worker ran. The
 * pure picks live in `llm/run-mode/fusion-team.ts`; this binds them to
 * the folder's policy, reachability and the session's choices.
 */
export interface FusionTeamContext {
  readonly team: UserFusionTeamConfig;
  readonly fusion: Pick<
    UserLlmFusionConfig,
    "orchestratorProvider" | "orchestratorModel" | "workerProvider" | "workerModel"
  >;
  readonly familyOf: (member: TeamMember) => TeamFamily;
  /** Whether the member can answer, as far as is known without a request. */
  readonly reachable: (member: TeamMember) => boolean;
  /** Whether a turn or completion on the provider can ask for a model of its own (not a local server). */
  readonly pinsModel: (providerId: string) => boolean;
  /**
   * The member's tier in the model tier table (`teamStrengthOf`, issue
   * #38); given, a task's reviewer is never weaker than its worker.
   */
  readonly strength?: (member: TeamMember) => ModelTier | null;
}

export interface FusionTeamRouting {
  /** Task routing by member; undefined when the team lists no `workers` (the worker leg serves, as before). */
  readonly tasks: TeamTaskRouting | undefined;
  /** The director leading the turn; null on a pinned turn or without one. */
  readonly director: TeamMember | null;
  /** Whether the team lists reviewers at all. */
  readonly hasReviewers: boolean;
  /** The reviewers the folder's policy allows and that can answer, in team order (the vision judge's fallbacks, issue #40). */
  readonly reviewers?: readonly TeamMember[];
  /**
   * The chat turned per-task review off (`reviewer: "none"`, issue #71):
   * no task gets a review, not even on `judgeProvider`.
   */
  readonly reviewOff: boolean;
  /**
   * The chat chose a reviewer that can serve here: review is on for the
   * chat even when `team.review` is `"off"` (the person asked for it).
   */
  readonly reviewChosen: boolean;
  /**
   * The reviewer of a task `worker` ran: the chat's reviewer when it can
   * serve (allowed, reachable, not the worker), else the team's pick;
   * null: `judgeProvider`, as before.
   */
  reviewerFor(worker: TeamMember, eligible?: (member: TeamMember) => boolean): TeamMember | null;
  readonly pinsModel: (providerId: string) => boolean;
}

/**
 * The team from the live config, or undefined without one. `reachable`
 * is the runtime's (`teamMemberReachable`: registered, and a CLI not
 * known to be signed out or missing); absent, a member is reachable when
 * its provider is configured.
 */
export function teamContextFromConfig(
  config: AtomicAgentConfig = getConfig(),
  reachable?: (member: TeamMember) => boolean,
): FusionTeamContext | undefined {
  const resolved = resolveLlmConfig(config);
  const fusion = resolved.runMode?.fusion;
  const team = fusion?.team;
  if (fusion === undefined || team === undefined) return undefined;
  const providers = resolved.providers;
  const entryOf = (providerId: string) => providers.find((p) => p.id === providerId);
  return {
    team,
    fusion,
    familyOf: teamFamilyOf(providers),
    strength: teamStrengthOf(providers),
    reachable: (member) => entryOf(member.providerId) !== undefined && (reachable?.(member) ?? true),
    pinsModel: (providerId) => {
      const entry = entryOf(providerId);
      return entry !== undefined && entry.kind !== "llama-server" && !isLocalServerUrl(entry.baseUrl ?? entry.url);
    },
  };
}

/**
 * Bind the team to this call: members the folder's policy refuses or
 * that cannot answer are left out of every pick; the session's own
 * worker (`currentWorker`) wins when it is still one of the workers, and
 * the turn's director (`currentDirector`, the run mode's) names the
 * orchestrator; none leads: null, and the run mode's orchestrator holds.
 * The chat's reviewer (`currentReviewer`, issue #71) reviews every task
 * it can serve, before the team's pick and whatever its strength (the
 * person chose it); `"none"` turns review off for the chat.
 */
export function resolveTeamRouting(
  context: FusionTeamContext,
  options: {
    allows: (providerId: string) => boolean;
    currentDirector?: () => TeamMember | null;
    currentWorker?: () => TeamMember | null;
    currentReviewer?: () => TeamMember | "none" | null;
    /**
     * The chat's effective provider policy is restricted (a folder
     * constraint, a read taint or a moved stamp). A reviewer whose CLI
     * keeps its own tools on (`cliToolsStayOn`: the Codex CLI's read-only
     * shell can read the whole disk) is then never a reviewer (issue #71).
     */
    restricted?: boolean;
    cliToolsStayOn?: (providerId: string) => boolean;
  },
): FusionTeamRouting {
  const { team, fusion } = context;
  const ok = (member: TeamMember): boolean => options.allows(member.providerId) && context.reachable(member);
  let tasks: TeamTaskRouting | undefined;
  if (team.workers !== undefined) {
    const workers = teamMembers(team, "workers").filter(ok);
    const current = options.currentWorker?.() ?? null;
    const chosen = current === null ? undefined : workers.find((m) => m.ref === current.ref);
    tasks = {
      workers,
      defaultWorker: chosen ?? defaultWorker(team, fusion, ok),
      pinsModel: context.pinsModel,
    };
  }
  const reviewerOk = (member: TeamMember): boolean =>
    ok(member) && !(options.restricted === true && options.cliToolsStayOn?.(member.providerId) === true);
  const reviewers = teamMembers(team, "reviewers").filter(reviewerOk);
  const chatReviewer = options.currentReviewer?.() ?? null;
  const reviewOff = chatReviewer === "none";
  const chosen = chatReviewer === null || chatReviewer === "none"
    ? undefined
    : reviewers.find((m) => m.ref === chatReviewer.ref);
  return {
    tasks,
    // The director that leads the turn, never a default it did not run on.
    director: options.currentDirector?.() ?? null,
    hasReviewers: teamMembers(team, "reviewers").length > 0,
    reviewers,
    reviewOff,
    reviewChosen: chosen !== undefined,
    reviewerFor: (worker, eligible = () => true) => {
      if (reviewOff) return null;
      if (chosen !== undefined && chosen.ref !== worker.ref && eligible(chosen)) return chosen;
      return pickReviewer(team, worker, {
        familyOf: context.familyOf,
        reachable: member => reviewerOk(member) && eligible(member),
        ...(context.strength === undefined ? {} : { strength: context.strength }),
      });
    },
    pinsModel: context.pinsModel,
  };
}
