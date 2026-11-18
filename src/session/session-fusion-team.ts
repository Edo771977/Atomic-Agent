/**
 * The fusion team members a session chose (issue #37): its director, its
 * preferred worker and (issue #71) its reviewer or "no review",
 * remembered per session in `metadata` next to the
 * `llm` stamp (`session-llm.ts`). The director is chosen per session,
 * never by rewriting the global config: `executeTurn` reads the stamp and
 * makes the turn's primary that member (`runtime/session-director.ts`).
 *
 * Both readers are defensive like `readSessionLlmStamp`: metadata is a
 * free-form JSON bag, so a value that is not a coherent member degrades
 * to "none chosen" rather than a crash or a wrong director.
 */
import { splitTeamMemberRef } from "../config/llm-fusion-team-config.js";
import type { TeamMember } from "../llm/run-mode/fusion-team.js";

/** Reserved `SessionState.metadata` key of the session's director. */
export const SESSION_FUSION_DIRECTOR_METADATA_KEY = "fusionDirector";
/** Reserved `SessionState.metadata` key of the session's preferred worker. */
export const SESSION_FUSION_WORKER_METADATA_KEY = "fusionWorker";
/**
 * Reserved `SessionState.metadata` key of the session's reviewer (issue
 * #71): a member stamp, or `{ member: "none" }` for no review in this chat.
 */
export const SESSION_FUSION_REVIEWER_METADATA_KEY = "fusionReviewer";
/** The reviewer choice that turns per-task review off for one chat. */
export const NO_REVIEWER = "none";

/** One chosen member, as stored. */
export interface SessionTeamMemberStamp {
  /** `"<providerId>:<model>"`, as the team lists it. */
  member: string;
  providerId: string;
  model: string;
  /** Epoch ms of the choice; `0` when an old or hand-edited stamp lacks it. */
  chosenAt: number;
}

function readStamp(raw: unknown): SessionTeamMemberStamp | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.member !== "string") return null;
  const split = splitTeamMemberRef(obj.member);
  // The halves must agree with the ref: a stamp that says two things
  // names no member at all.
  if (split === null || obj.providerId !== split.providerId || obj.model !== split.model) return null;
  const chosenAt = typeof obj.chosenAt === "number" && Number.isFinite(obj.chosenAt) && obj.chosenAt >= 0
    ? obj.chosenAt
    : 0;
  return { member: obj.member, providerId: split.providerId, model: split.model, chosenAt };
}

function writeStamp(
  metadata: Record<string, unknown> | undefined,
  key: string,
  member: TeamMember | null,
  at: number,
): Record<string, unknown> {
  const { [key]: _previous, ...rest } = metadata ?? {};
  if (member === null) return rest;
  const stamp: SessionTeamMemberStamp = {
    member: member.ref,
    providerId: member.providerId,
    model: member.model,
    chosenAt: at,
  };
  return { ...rest, [key]: stamp };
}

/** The session's director stamp, or null when none (or a malformed one) is stored. */
export function readSessionFusionDirector(
  metadata: Record<string, unknown> | undefined,
): SessionTeamMemberStamp | null {
  return readStamp(metadata?.[SESSION_FUSION_DIRECTOR_METADATA_KEY]);
}

/** The session's preferred-worker stamp, or null. */
export function readSessionFusionWorker(
  metadata: Record<string, unknown> | undefined,
): SessionTeamMemberStamp | null {
  return readStamp(metadata?.[SESSION_FUSION_WORKER_METADATA_KEY]);
}

/** `metadata` with the director set to `member` (null clears it); a new object. */
export function withSessionFusionDirector(
  metadata: Record<string, unknown> | undefined,
  member: TeamMember | null,
  at: number = Date.now(),
): Record<string, unknown> {
  return writeStamp(metadata, SESSION_FUSION_DIRECTOR_METADATA_KEY, member, at);
}

/** `metadata` with the preferred worker set to `member` (null clears it); a new object. */
export function withSessionFusionWorker(
  metadata: Record<string, unknown> | undefined,
  member: TeamMember | null,
  at: number = Date.now(),
): Record<string, unknown> {
  return writeStamp(metadata, SESSION_FUSION_WORKER_METADATA_KEY, member, at);
}

/**
 * The session's reviewer: its stamp, `"none"` when the chat turned review
 * off, or null when none (or a malformed one) is stored.
 */
export function readSessionFusionReviewer(
  metadata: Record<string, unknown> | undefined,
): SessionTeamMemberStamp | typeof NO_REVIEWER | null {
  const raw = metadata?.[SESSION_FUSION_REVIEWER_METADATA_KEY];
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw) && (raw as { member?: unknown }).member === NO_REVIEWER) {
    return NO_REVIEWER;
  }
  return readStamp(raw);
}

/** `metadata` with the reviewer set to `member`, `"none"` (no review) or cleared (null); a new object. */
export function withSessionFusionReviewer(
  metadata: Record<string, unknown> | undefined,
  member: TeamMember | typeof NO_REVIEWER | null,
  at: number = Date.now(),
): Record<string, unknown> {
  if (member !== NO_REVIEWER) return writeStamp(metadata, SESSION_FUSION_REVIEWER_METADATA_KEY, member, at);
  const { [SESSION_FUSION_REVIEWER_METADATA_KEY]: _previous, ...rest } = metadata ?? {};
  return { ...rest, [SESSION_FUSION_REVIEWER_METADATA_KEY]: { member: NO_REVIEWER, chosenAt: at } };
}

/** The stamp as a team member, for the run-mode helpers. */
export function stampMember(stamp: SessionTeamMemberStamp): TeamMember {
  return { providerId: stamp.providerId, model: stamp.model, ref: stamp.member };
}
