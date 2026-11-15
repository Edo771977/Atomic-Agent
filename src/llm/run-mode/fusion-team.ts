import { splitTeamMemberRef } from "../../config/llm-fusion-team-config.js";
import {
  LOCAL_PROVIDER_KIND,
  type UserFusionTeamConfig,
  type UserLlmFusionConfig,
} from "../../config/llm-run-mode-config.js";
import type { ProviderPolicy } from "../../config/project-constraint-match.js";
import { SUBSCRIPTION_CLI_KIND } from "../../config/provider-auth-mode.js";
import { isLocalServerUrl } from "../provider/openai/local-server-url.js";
import type { ProviderKeyStatus } from "../provider/provider-key.js";
import type { SubscriptionCliState } from "../provider/subscription-cli/subscription-cli-status.js";
import type { FusionSetupFacts } from "./fusion-setup-plan.js";

/**
 * The fusion team (issue #37, `llm.runMode.fusion.team`): pure helpers
 * that read members, their family and whether they can answer, and pick
 * the default director, the default worker and a task's reviewer.
 * Nothing here reads config, state or the network; callers pass the
 * team, the facts and the folder's policy. See README.md.
 */

/** One `"<providerId>:<model>"` member. Members are compared by `ref`, never by provider alone. */
export interface TeamMember {
  readonly providerId: string;
  readonly model: string;
  /** `"<providerId>:<model>"`, as written in the config. */
  readonly ref: string;
}

/** Which vendor's models a member runs; cross-family review compares these. */
export type TeamFamily = "anthropic" | "openai" | "local" | "other";

export type TeamRole = "directors" | "workers" | "reviewers";

/** What {@link memberFamily} needs of a provider entry (a `UserLlmProviderEntry` fits). */
export interface TeamProviderRef {
  readonly kind: string;
  /** `subscriptionCli.cli` of a subscription entry, as a name or the entry's block. */
  readonly subscriptionCli?: string | { readonly cli?: string } | null;
  readonly baseUrl?: string;
  readonly url?: string;
}

/** One provider as reachability sees it; `FusionSetupProviderFact` fits. */
export interface TeamProviderFact {
  readonly id: string;
  readonly kind: string;
  readonly keyState: ProviderKeyStatus["state"];
  readonly subscriptionCli: string | null;
}

/**
 * What {@link memberReachable} reads. The CLI fills it from
 * `detectFusionSetup` ({@link teamFactsFromSetup}); the TUI can fill it
 * from its own provider and CLI status without importing the CLI.
 */
export interface TeamReachabilityFacts {
  readonly providers: readonly TeamProviderFact[];
  /** Status per subscription CLI that was checked; one not listed was not checked. */
  readonly subscriptionClis: Readonly<Record<string, { readonly state: SubscriptionCliState }>>;
  /** Whether the local engine can serve now; unset counts as yes. */
  readonly localReady?: boolean;
}

/** A member from `"<providerId>:<model>"`; null when it is not one. */
export function parseTeamMember(raw: string): TeamMember | null {
  const split = splitTeamMemberRef(raw);
  return split === null ? null : { ...split, ref: raw };
}

/** The members of one list of the team, in config order; empty when the team or the list is unset. */
export function teamMembers(team: UserFusionTeamConfig | undefined, role: TeamRole): TeamMember[] {
  const list = team?.[role] ?? [];
  return list.map(parseTeamMember).filter((m): m is TeamMember => m !== null);
}

function hostOf(url: string | undefined): string | null {
  if (url === undefined) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function cliName(ref: TeamProviderRef): string | undefined {
  const cli = ref.subscriptionCli;
  return typeof cli === "string" ? cli : (cli?.cli ?? undefined);
}

/**
 * The member's family, from its provider's kind: `anthropic` (the
 * Anthropic API, Claude Code), `openai` (Codex, an OpenAI-compatible
 * entry on OpenAI's or Azure OpenAI's endpoint), `local` (llama-server,
 * an OpenAI-compatible entry on this machine), and for a router
 * (OpenRouter, AI/ML API) the vendor prefix of the model id. Anything
 * else, or a bare kind that cannot tell, is `other`.
 */
export function memberFamily(member: TeamMember, provider: string | TeamProviderRef): TeamFamily {
  const ref: TeamProviderRef = typeof provider === "string" ? { kind: provider } : provider;
  switch (ref.kind) {
    case LOCAL_PROVIDER_KIND:
      return "local";
    case "anthropic":
      return "anthropic";
    case SUBSCRIPTION_CLI_KIND: {
      const cli = cliName(ref);
      return cli === "claude" ? "anthropic" : cli === "codex" ? "openai" : "other";
    }
    case "openrouter":
    case "aimlapi": {
      const vendor = member.model.split("/", 1)[0]?.toLowerCase();
      return vendor === "anthropic" ? "anthropic" : vendor === "openai" ? "openai" : "other";
    }
    case "openai-compatible":
    case "qwen-openai-compatible": {
      const url = ref.baseUrl ?? ref.url;
      if (isLocalServerUrl(url)) return "local";
      const host = hostOf(url);
      if (host === "api.openai.com" || host?.endsWith(".openai.azure.com")) return "openai";
      return "other";
    }
    default:
      return "other";
  }
}

/** {@link memberFamily} over a provider list; a member whose provider is not listed is `other`. */
export function teamFamilyOf(
  providers: readonly ({ readonly id: string } & TeamProviderRef)[],
): (member: TeamMember) => TeamFamily {
  return (member) => {
    const provider = providers.find((p) => p.id === member.providerId);
    return provider === undefined ? "other" : memberFamily(member, provider);
  };
}

/**
 * Whether the member can answer, as far as the facts know: its provider
 * is configured, and it is not known to be broken. A subscription CLI
 * that is missing or signed out, an API entry whose key is missing, and
 * the local engine with `localReady: false` cannot; an inconclusive or
 * unchecked CLI login, or a key that cannot be checked, is not a refusal
 * (the turn itself reports it), the same rule `setup fusion` keeps a
 * stored orchestrator by.
 */
export function memberReachable(facts: TeamReachabilityFacts, member: TeamMember): boolean {
  const provider = facts.providers.find((p) => p.id === member.providerId);
  if (provider === undefined) return false;
  if (provider.kind === LOCAL_PROVIDER_KIND) return facts.localReady !== false;
  if (provider.kind === SUBSCRIPTION_CLI_KIND) {
    if (provider.subscriptionCli === null) return false;
    const state = facts.subscriptionClis[provider.subscriptionCli]?.state;
    return state !== "missing" && state !== "signed_out";
  }
  return provider.keyState !== "missing";
}

/** {@link TeamReachabilityFacts} from what `detectFusionSetup` gathered. */
export function teamFactsFromSetup(facts: FusionSetupFacts): TeamReachabilityFacts {
  const local = facts.local;
  const localReady =
    (local.mode === "external" && local.externalAnswers === true) ||
    (local.mode === "managed" && local.managedModelId !== null && local.managedModelOnDisk);
  return { providers: facts.providers, subscriptionClis: facts.subscriptionClis, localReady };
}

/**
 * The members the folder's provider policy allows (`projects.constraints`,
 * issue #34), directors included; no policy keeps them all. The check is
 * on the provider id, which a per-turn model copy keeps, so it matches
 * what dispatch enforces. Pass `currentProviderPolicy()` at a call site
 * inside a policy frame.
 */
export function filterByPolicy(
  members: readonly TeamMember[],
  policy: Pick<ProviderPolicy, "allows"> | undefined,
): TeamMember[] {
  return policy === undefined ? [...members] : members.filter((m) => policy.allows(m.providerId));
}

const always = (): boolean => true;

/** The first of `members` on `providerId` that passes `ok`, preferring the one on `model`. */
function onProvider(
  members: readonly TeamMember[],
  providerId: string | undefined,
  model: string | undefined,
  ok: (member: TeamMember) => boolean,
): TeamMember | undefined {
  if (providerId === undefined) return undefined;
  const candidates = members.filter((m) => m.providerId === providerId && ok(m));
  return candidates.find((m) => m.model === model) ?? candidates[0];
}

/**
 * The director a session gets when none was chosen: the director on
 * `orchestratorProvider` (the one on `orchestratorModel` among several),
 * else the first director. With `reachable`, only directors that pass
 * it count. Null when none does.
 */
export function defaultDirector(
  team: UserFusionTeamConfig,
  fusion: Pick<UserLlmFusionConfig, "orchestratorProvider" | "orchestratorModel">,
  reachable: (member: TeamMember) => boolean = always,
): TeamMember | null {
  const directors = teamMembers(team, "directors");
  return (
    onProvider(directors, fusion.orchestratorProvider, fusion.orchestratorModel, reachable) ??
    directors.find(reachable) ??
    null
  );
}

/**
 * The worker of a task that names none: the reachable worker on
 * `workerProvider` (the one on `workerModel` among several), else the
 * first reachable worker. Null when the team lists no workers (the
 * worker leg serves, as before) or none is reachable.
 */
export function defaultWorker(
  team: UserFusionTeamConfig,
  fusion: Pick<UserLlmFusionConfig, "workerProvider" | "workerModel">,
  reachable: (member: TeamMember) => boolean,
): TeamMember | null {
  const workers = teamMembers(team, "workers");
  return onProvider(workers, fusion.workerProvider, fusion.workerModel, reachable) ?? workers.find(reachable) ?? null;
}

export interface PickReviewerOptions {
  readonly familyOf: (member: TeamMember) => TeamFamily;
  readonly reachable: (member: TeamMember) => boolean;
}

/**
 * The reviewer (judge) of a task `worker` ran. With `crossFamilyReview`
 * (the default) the first reachable reviewer whose family differs from
 * the worker's; with it off, the first reachable reviewer that is not
 * the worker itself. Null when there is none: the caller falls back to
 * `judgeProvider`, as before the team.
 */
export function pickReviewer(
  team: UserFusionTeamConfig,
  worker: TeamMember,
  opts: PickReviewerOptions,
): TeamMember | null {
  const cross = team.crossFamilyReview ?? true;
  const workerFamily = cross ? opts.familyOf(worker) : undefined;
  return (
    teamMembers(team, "reviewers").find(
      (r) =>
        r.ref !== worker.ref &&
        (!cross || opts.familyOf(r) !== workerFamily) &&
        opts.reachable(r),
    ) ?? null
  );
}
