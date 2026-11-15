import type { UserLlmFusionConfig } from "../config/llm-run-mode-config.js";
import type { ProviderPolicy } from "../config/project-constraint-match.js";
import { SUBSCRIPTION_CLI_KIND } from "../config/provider-auth-mode.js";
import type { ResolvedLlmConfig } from "../llm/provider/registry/provider-types.js";
import {
  defaultDirector,
  filterByPolicy,
  teamMembers,
  type TeamMember,
} from "../llm/run-mode/fusion-team.js";
import {
  readSessionFusionDirector,
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
  role: "directors" | "workers",
  ref: string,
): TeamMember | null {
  return teamMembers(fusion?.team, role).find((m) => m.ref === ref) ?? null;
}

/** What one turn runs with: the run mode's `director` / `worker` options. */
export interface SessionTeamChoice {
  readonly director: TeamMember | null;
  readonly worker: TeamMember | null;
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
