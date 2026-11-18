import type { UserLlmFusionConfig } from "../config/llm-run-mode-config.js";
import type { ProviderPolicy } from "../config/project-constraint-match.js";
import { SUBSCRIPTION_CLI_KIND } from "../config/provider-auth-mode.js";
import type { ResolvedLlmConfig } from "../llm/provider/registry/provider-types.js";
import {
  defaultDirector,
  filterByPolicy,
  reviewEnabled,
  teamMembers,
  type TeamMember,
} from "../llm/run-mode/fusion-team.js";
import {
  NO_REVIEWER,
  readSessionFusionDirector,
  readSessionFusionReviewer,
  readSessionFusionWorker,
  stampMember,
} from "../session/session-fusion-team.js";

/**
 * The director of a fusion session (issue #37): which team member plans,
 * delegates and replies for it. Chosen per session and stored in its
 * metadata (`session/session-fusion-team.ts`), never written into the
 * global config; `executeTurn` makes it the turn's primary and the run
 * mode's orchestrator leg. See README.md → "Fusion director".
 */

/** Why the session has the director it has. */
export type SessionDirectorReason =
  /** The session's own stamp: the person chose it, or an earlier turn did. */
  | "stamped"
  /** The only director that is reachable and allowed here. */
  | "only"
  /** One of several: the team's default (`defaultDirector`). */
  | "default";

export interface SessionDirectorChoice {
  readonly member: TeamMember;
  readonly reason: SessionDirectorReason;
}

type Policy = Pick<ProviderPolicy, "allows"> | undefined;

/** The team's directors this folder allows and that can answer, in config order. */
export function sessionDirectorOptions(
  fusion: UserLlmFusionConfig | undefined,
  policy: Policy,
  reachable: (member: TeamMember) => boolean,
): TeamMember[] {
  return filterByPolicy(teamMembers(fusion?.team, "directors"), policy).filter(reachable);
}

/**
 * The session's director and why. No team: null, and fusion runs as it
 * did before the team. A stamp the team still lists wins, even when the
 * folder's policy refuses its provider: the turn then refuses out loud
 * (`assertProviderAllowed`) instead of quietly leading with another
 * member. Otherwise the only reachable and allowed director, else the
 * team's default among those; null when there is none.
 */
export function sessionDirectorChoice(
  metadata: Record<string, unknown> | undefined,
  fusion: UserLlmFusionConfig | undefined,
  policy: Policy,
  reachable: (member: TeamMember) => boolean,
): SessionDirectorChoice | null {
  const team = fusion?.team;
  if (team === undefined) return null;
  const stamp = readSessionFusionDirector(metadata);
  if (stamp !== null && teamMembers(team, "directors").some((d) => d.ref === stamp.member)) {
    return { member: stampMember(stamp), reason: "stamped" };
  }
  const options = sessionDirectorOptions(fusion, policy, reachable);
  if (options.length === 0) return null;
  if (options.length === 1) return { member: options[0]!, reason: "only" };
  const member = defaultDirector(team, fusion ?? {}, (d) => options.some((o) => o.ref === d.ref));
  return member === null ? null : { member, reason: "default" };
}

/** {@link sessionDirectorChoice}'s member: the contract part C and the frontends read. */
export function resolveSessionDirector(
  metadata: Record<string, unknown> | undefined,
  fusion: UserLlmFusionConfig | undefined,
  policy: Policy,
  reachable: (member: TeamMember) => boolean,
): TeamMember | null {
  return sessionDirectorChoice(metadata, fusion, policy, reachable)?.member ?? null;
}

/**
 * The session's preferred worker: its stamp, while the team's `workers`
 * list it and the folder allows it; else null (the task's own pick, then
 * `defaultWorker`, decide).
 */
export function resolveSessionWorker(
  metadata: Record<string, unknown> | undefined,
  fusion: UserLlmFusionConfig | undefined,
  policy: Policy,
): TeamMember | null {
  const stamp = readSessionFusionWorker(metadata);
  if (stamp === null) return null;
  const listed = teamMembers(fusion?.team, "workers").some((w) => w.ref === stamp.member);
  if (!listed || policy?.allows(stamp.providerId) === false) return null;
  return stampMember(stamp);
}

/**
 * The session's reviewer (issue #71): `"none"` when the chat turned
 * review off; its stamp while the team's `reviewers` list it and the
 * folder allows it; else null (the team's pick, `pickReviewer`, decides).
 */
export function resolveSessionReviewer(
  metadata: Record<string, unknown> | undefined,
  fusion: UserLlmFusionConfig | undefined,
  policy: Policy,
): TeamMember | typeof NO_REVIEWER | null {
  const stamp = readSessionFusionReviewer(metadata);
  if (stamp === null || stamp === NO_REVIEWER) return stamp;
  const listed = teamMembers(fusion?.team, "reviewers").some((r) => r.ref === stamp.member);
  if (!listed || policy?.allows(stamp.providerId) === false) return null;
  return stampMember(stamp);
}

/**
 * The one line a frontend shows when the runtime picked the session's
 * director itself (`fusion_director_notice`): which member and why, so
 * a person who has several can see they did not choose this one.
 */
export function directorPickedNoticeText(member: TeamMember, reason: "only" | "default", directors: number): string {
  return reason === "only"
    ? `fusion director: ${member.ref} (the only director available)`
    : `fusion director: ${member.ref} (the team's default of ${directors} directors)`;
}

/**
 * Whether `providerId` is the Codex CLI. A Codex director keeps its own
 * shell on (read-only), so `fusion.delegate` refuses `model:
 * "orchestrator"` tasks on it (`cliToolsStayOn`) and they go to workers.
 */
export function isCodexCliProvider(resolved: ResolvedLlmConfig, providerId: string): boolean {
  const entry = resolved.providers.find((p) => p.id === providerId);
  return entry?.kind === SUBSCRIPTION_CLI_KIND && entry.subscriptionCli?.cli === "codex";
}

/** The Codex director's line, said once when a session starts on it. */
export function codexDirectorNoticeText(): string {
  return 'codex director: tasks for the director itself (model: "orchestrator") go to the workers';
}

/** A team member named by a caller (`--director`, a sidecar/HTTP field) that the team lists in `role`. */
export function teamMemberByRef(
  fusion: UserLlmFusionConfig | undefined,
  role: "directors" | "workers" | "reviewers",
  ref: string,
): TeamMember | null {
  return teamMembers(fusion?.team, role).find((m) => m.ref === ref) ?? null;
}

/** What one turn runs with: the run mode's `director` / `worker` options, and the chat's reviewer. */
export interface SessionTeamChoice {
  readonly director: TeamMember | null;
  readonly worker: TeamMember | null;
  /** The chat's reviewer (`resolveSessionReviewer`): a member, `"none"` (no review), or null/absent (the team picks). */
  readonly reviewer?: TeamMember | typeof NO_REVIEWER | null;
}

/**
 * The team choice of each turn running now, by session id. Owned by one
 * runtime: `executeTurn` sets it for the turn and releases it after, so
 * readers that only know the ambient session (the live run mode, whose
 * `director` `fusion.delegate` reads) see that session's director. A fusion
 * worker's session borrows its parent's for its own turn.
 */
export interface SessionTeamChoices {
  /** Hold `choice` for `sessionId`; the returned release drops it only if it is still the one held. */
  set(sessionId: string, choice: SessionTeamChoice): () => void;
  /** Hold the parent's current choice for a worker session. */
  borrow(sessionId: string, parentSessionId: string): () => void;
  get(sessionId: string | undefined): SessionTeamChoice | undefined;
}

export function createSessionTeamChoices(): SessionTeamChoices {
  const held = new Map<string, SessionTeamChoice>();
  const set = (sessionId: string, choice: SessionTeamChoice): (() => void) => {
    held.set(sessionId, choice);
    return () => {
      if (held.get(sessionId) === choice) held.delete(sessionId);
    };
  };
  return {
    set,
    borrow: (sessionId, parentSessionId) => {
      const parent = held.get(parentSessionId);
      return parent === undefined ? () => {} : set(sessionId, parent);
    },
    get: (sessionId) => (sessionId === undefined ? undefined : held.get(sessionId)),
  };
}

/** One team member as a frontend lists it (issue #71). */
export interface TeamRosterMember {
  readonly ref: string;
  readonly providerId: string;
  readonly model: string;
  /** Whether the member can serve this chat now: reachable and allowed by its folder. */
  readonly usable: boolean;
  /** Why not: the folder refuses its provider, or it cannot answer now. */
  readonly reason?: "folder" | "unreachable";
  /** The reason as one line to show as is. */
  readonly why?: string;
}

/** The team for a frontend's seats (`GET /api/fusion/team`, issue #71). */
export interface TeamRoster {
  readonly directors: TeamRosterMember[];
  readonly workers: TeamRosterMember[];
  readonly reviewers: TeamRosterMember[];
  /** Whether tasks get a review by the config alone (`reviewEnabled`); a chat's own choice can change it. */
  readonly review: "on" | "off";
  /** The chat's stamped choices; `reviewer: "none"` is no review in this chat. */
  readonly chat: { director: string | null; worker: string | null; reviewer: string | null };
}

/**
 * Every team member by role, each with whether this chat can use it:
 * `restriction` is the chat folder's provider restriction (null: none),
 * `reachable` the runtime's `teamMemberReachable`. Null without a team.
 */
export function fusionTeamRoster(
  fusion: UserLlmFusionConfig | undefined,
  metadata: Record<string, unknown> | undefined,
  restriction: { allowedProviders: readonly string[]; folder: string } | null,
  reachable: (member: TeamMember) => boolean,
): TeamRoster | null {
  const team = fusion?.team;
  if (team === undefined) return null;
  const row = (member: TeamMember): TeamRosterMember => {
    const base = { ref: member.ref, providerId: member.providerId, model: member.model };
    if (restriction !== null && !restriction.allowedProviders.includes(member.providerId)) {
      return { ...base, usable: false, reason: "folder", why: `this folder (${restriction.folder}) does not allow ${member.providerId}` };
    }
    if (!reachable(member)) {
      return {
        ...base, usable: false, reason: "unreachable",
        why: `${member.providerId} cannot answer now (not configured, signed out or not installed)`,
      };
    }
    return { ...base, usable: true };
  };
  const reviewer = readSessionFusionReviewer(metadata);
  return {
    directors: teamMembers(team, "directors").map(row),
    workers: teamMembers(team, "workers").map(row),
    reviewers: teamMembers(team, "reviewers").map(row),
    review: reviewEnabled(team, fusion?.judge) ? "on" : "off",
    chat: {
      director: readSessionFusionDirector(metadata)?.member ?? null,
      worker: readSessionFusionWorker(metadata)?.member ?? null,
      reviewer: reviewer === null ? null : reviewer === NO_REVIEWER ? NO_REVIEWER : reviewer.member,
    },
  };
}
