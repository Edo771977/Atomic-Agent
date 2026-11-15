import type { SubscriptionCliState } from "../provider/subscription-cli/subscription-cli-status.js";
import { memberReachable, type TeamMember, type TeamReachabilityFacts } from "./fusion-team.js";

/**
 * Whether a fusion team member can answer now, for the runtime, the TUI
 * and `fusion.delegate` (issue #37): its provider is registered, and a
 * subscription CLI is not known to be missing or signed out. The CLI's
 * state comes from a cache that checks in the background and is never
 * awaited by a turn: until a check lands the CLI counts as reachable (the
 * turn itself reports a failure), the rule {@link memberReachable} keeps.
 */

/** How long one CLI check is trusted before a read starts another. */
export const SUBSCRIPTION_CLI_STATUS_TTL_MS = 5 * 60_000;

export interface SubscriptionCliStatusCache {
  /** The last checked state of `cli`; undefined before a check landed. */
  stateOf(cli: string): SubscriptionCliState | undefined;
  /** Start a check of `cli` unless one is running or fresh; never waits. */
  refresh(cli: string, binPath?: string): void;
}

export function createSubscriptionCliStatusCache(deps: {
  check: (cli: string, binPath: string | undefined) => Promise<{ state: SubscriptionCliState }>;
  now?: () => number;
  ttlMs?: number;
}): SubscriptionCliStatusCache {
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? SUBSCRIPTION_CLI_STATUS_TTL_MS;
  const known = new Map<string, { state: SubscriptionCliState; at: number }>();
  const running = new Set<string>();
  return {
    stateOf: (cli) => known.get(cli)?.state,
    refresh(cli, binPath) {
      if (running.has(cli)) return;
      const last = known.get(cli);
      if (last !== undefined && now() - last.at < ttlMs) return;
      running.add(cli);
      void Promise.resolve()
        .then(() => deps.check(cli, binPath))
        .then(
          (report) => { known.set(cli, { state: report.state, at: now() }); },
          // A check that failed knows nothing: the CLI stays as it was.
          () => {},
        )
        .finally(() => { running.delete(cli); });
    },
  };
}

interface ReachabilityProviderEntry {
  readonly id: string;
  readonly kind: string;
  readonly subscriptionCli?: { readonly cli: string; readonly binPath?: string };
}

/** The live reachability of one member; reading a CLI member starts its background check. */
export function liveTeamReachability(input: {
  providers: readonly ReachabilityProviderEntry[];
  registered: (providerId: string) => boolean;
  cache: SubscriptionCliStatusCache;
}): (member: TeamMember) => boolean {
  return (member) => {
    const entry = input.providers.find((p) => p.id === member.providerId);
    if (entry === undefined || !input.registered(entry.id)) return false;
    const cli = entry.subscriptionCli?.cli;
    if (cli !== undefined) input.cache.refresh(cli, entry.subscriptionCli?.binPath);
    const state = cli === undefined ? undefined : input.cache.stateOf(cli);
    const facts: TeamReachabilityFacts = {
      // Registered: the registry built it, so its key is not missing.
      providers: [{ id: entry.id, kind: entry.kind, keyState: "present", subscriptionCli: cli ?? null }],
      subscriptionClis: cli === undefined || state === undefined ? {} : { [cli]: { state } },
    };
    return memberReachable(facts, member);
  };
}
