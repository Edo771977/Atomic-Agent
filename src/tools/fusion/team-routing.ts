import { getConfig } from "../../config/index.js";
import type { AtomicAgentConfig } from "../../config/index.js";
import type { UserFusionTeamConfig, UserLlmFusionConfig } from "../../config/llm-run-mode-config.js";
import { isLocalServerUrl } from "../../llm/provider/openai/local-server-url.js";
import { resolveLlmConfig } from "../../llm/provider/registry/provider-types.js";
import {
  defaultDirector,
  defaultWorker,
  pickReviewer,
  teamFamilyOf,
  teamMembers,
  type TeamFamily,
  type TeamMember,
} from "../../llm/run-mode/fusion-team.js";
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
}

export interface FusionTeamRouting {
  /** Task routing by member; undefined when the team lists no `workers` (the worker leg serves, as before). */
  readonly tasks: TeamTaskRouting | undefined;
  /** The session's director, else the default one; null when none passes. */
  readonly director: TeamMember | null;
  /** Whether the team lists reviewers at all. */
  readonly hasReviewers: boolean;
  /** The reviewer of a task `worker` ran; null: `judgeProvider`, as before. */
  reviewerFor(worker: TeamMember): TeamMember | null;
  readonly pinsModel: (providerId: string) => boolean;
}

/**
 * The team from the live config, or undefined without one. Reachability
 * here is only "its provider is configured": a sign-in or key problem
 * surfaces on the turn itself, as it does for any leg.
 */
export function teamContextFromConfig(config: AtomicAgentConfig = getConfig()): FusionTeamContext | undefined {
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
    reachable: (member) => entryOf(member.providerId) !== undefined,
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
 * the session's director (`currentDirector`) when one was chosen.
 */
export function resolveTeamRouting(
  context: FusionTeamContext,
  options: {
    allows: (providerId: string) => boolean;
    currentDirector?: () => TeamMember | null;
    currentWorker?: () => TeamMember | null;
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
  return {
    tasks,
    director: options.currentDirector?.() ?? defaultDirector(team, fusion, ok),
    hasReviewers: teamMembers(team, "reviewers").length > 0,
    reviewerFor: (worker) => pickReviewer(team, worker, { familyOf: context.familyOf, reachable: ok }),
    pinsModel: context.pinsModel,
  };
}
