import type { AtomicAgentConfig } from "../config/index.js";
import {
  hasProjectConstraints,
  makeProviderPolicy,
  providerPolicyFromStamp,
  resolveProjectConstraint,
  toProviderPolicyStamp,
  currentProviderPolicyFrame,
  intersectProviderPolicies,
  policyCovers,
  type ProviderPolicy,
  type ProviderPolicyStamp,
} from "../llm/provider-policy.js";
import { readFusionWorkerMeta } from "../session/fusion-worker-session.js";
import { READ_TAINT_METADATA_KEY, readTaintOf } from "./session-read-taint.js";

/** The policy that lets no provider serve: what an unscoped caller gets while constraints exist. */
export function refuseAllPolicy(key: string, matchedDir = ""): ProviderPolicy {
  return makeProviderPolicy({ key, allowedProviders: [], matchedDir });
}

export interface SessionProviderPolicyDeps {
  /** The live config (`getConfig`), read on every call so an edit lands. */
  readConfig: () => Pick<AtomicAgentConfig, "projects">;
  /** A stored session's folder and metadata, or null when there is none. */
  loadSession: (sessionId: string) => { workingDir: string; metadata?: Record<string, unknown> } | null;
  /**
   * The object a running turn holds for a session (read taint's live
   * registry), whose metadata carries a taint set mid-turn before the
   * turn saves it. Read by a check made outside the turn's frame (a chat
   * adapter's send, issue #33).
   */
  liveSession?: (sessionId: string) => { workingDir: string; metadata?: Record<string, unknown> } | undefined;
}

/**
 * How the runtime answers "which provider policy governs this session"
 * (issue #33), for `executeTurn` and every caller that only has a
 * session id.
 *
 * - A real session: its folder, matched live against
 *   `projects.constraints` (`resolveProjectConstraint`).
 * - A fusion worker: the policy its parent's turn stamped at fan-out
 *   (`FusionWorkerMeta.providerPolicy`), never its own folder, which may
 *   be a temp copy outside every constrained folder. A worker without a
 *   stamp while any constraint exists is refused everything.
 * - A side call's partition id (`reflection:<id>`) reads as its session.
 * - A session that read files inside a constrained folder also carries
 *   that folder's constraint (its stored read taint), intersected.
 * - An id that names no stored session while constraints exist: refused
 *   everything (fail closed).
 */
function narrow(a: ProviderPolicy | undefined, b: ProviderPolicy | undefined): ProviderPolicy | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return intersectProviderPolicies(a, b);
}

export function createSessionProviderPolicy(deps: SessionProviderPolicyDeps) {
  const constraintsActive = (): boolean => hasProjectConstraints(deps.readConfig());
  const forWorkingDir = (workingDir: string): ProviderPolicy | undefined =>
    resolveProjectConstraint(deps.readConfig(), workingDir);
  const forSession = (session: { id: string; workingDir: string; metadata?: Record<string, unknown> }): ProviderPolicy | undefined => {
    // Read taint (session-read-taint.ts): what the session read inside a
    // constrained folder holds on top of its own folder's policy.
    const own = ownPolicy(session);
    const taint = readTaintOf(session.metadata);
    if (taint === undefined) return own;
    return own === undefined ? taint : intersectProviderPolicies(own, taint);
  };
  const ownPolicy = (session: { id: string; workingDir: string; metadata?: Record<string, unknown> }): ProviderPolicy | undefined => {
    const worker = readFusionWorkerMeta(session.metadata);
    if (worker !== null) {
      const stamp = worker.providerPolicy;
      if (stamp === null) return undefined;
      if (stamp === undefined) {
        return constraintsActive() ? refuseAllPolicy("(fusion worker without its parent's policy)", session.workingDir) : undefined;
      }
      return providerPolicyFromStamp(stamp) ?? refuseAllPolicy("(fusion worker with an unreadable policy)", session.workingDir);
    }
    return forWorkingDir(session.workingDir);
  };
  const forSessionId = (sessionId: string): ProviderPolicy | undefined => {
    if (!constraintsActive()) return undefined;
    // Side calls partition the chain as `<kind>:<session id>`
    // (`reflection:`, `compaction:`, `rewriter:`, ...): the session is
    // the part after the prefix.
    let id = sessionId;
    let session = deps.loadSession(id);
    for (let hops = 0; session === null && hops < 4 && id.indexOf(":") > 0; hops += 1) {
      id = id.slice(id.indexOf(":") + 1);
      session = deps.loadSession(id);
    }
    if (session === null) return refuseAllPolicy(`(unknown session ${sessionId})`);
    return forSession({ id, ...session });
  };
  /**
   * The policy that governs a session right now: the policy frame of the
   * turn running for it (which already holds a fusion worker's stamp),
   * or otherwise the session's own: `forSession` for a session object
   * (a chat session not stored yet), `forSessionId` for an id (fail
   * closed). A frame set for another session is not borrowed.
   * The tool dispatch guard (egress, `tools/tool-egress.ts`) reads it
   * through this one function, so a later rule that narrows a session's
   * policy mid-turn (a read taint) extends it here and every check
   * follows.
   */
  const effectivePolicyForSession = (
    target: string | { id: string; workingDir: string; metadata?: Record<string, unknown> },
  ): ProviderPolicy | undefined => {
    const id = typeof target === "string" ? target : target.id;
    const frame = currentProviderPolicyFrame();
    if (frame !== undefined && (frame.sessionId === undefined || frame.sessionId === id)) return frame.policy;
    // Every view of the session narrows: the caller's object (possibly a
    // stale copy), the stored row, and the running turn's object, whose
    // taint may not be saved yet. A taint only ever narrows, so the
    // intersection is the freshest answer.
    let policy: ProviderPolicy | undefined;
    if (typeof target === "string") {
      policy = forSessionId(target);
    } else {
      policy = forSession(target);
      const stored = constraintsActive() ? deps.loadSession(id) : null;
      if (stored !== null) policy = narrow(policy, forSession({ id, ...stored }));
    }
    const live = constraintsActive() ? deps.liveSession?.(id) : undefined;
    if (live !== undefined) policy = narrow(policy, forSession({ id, ...live }));
    return policy;
  };
  return { constraintsActive, forWorkingDir, forSession, forSessionId, effectivePolicyForSession };
}

export type SessionProviderPolicy = ReturnType<typeof createSessionProviderPolicy>;

export const CHANNEL_RESTRICTED_CODE = "ATOMIC_AGENT_CHANNEL_RESTRICTED";
/**
 * The only text a chat gets back for a turn refused in a constrained
 * folder: fixed, so no session content (not even the folder) leaves.
 */
export const CHANNEL_RESTRICTED_NOTICE = "This folder is restricted; open atomic-agent on the computer.";

/**
 * A turn that arrived from a remote chat (Telegram, Discord, a swarm
 * bot) for a session in a constrained folder whose `allowedEgress` does
 * not list `channels` (issue #33). Thrown before the model runs; the
 * chat adapters answer with `CHANNEL_RESTRICTED_NOTICE` alone.
 */
export class ChannelRestrictedError extends Error {
  readonly code = CHANNEL_RESTRICTED_CODE;
  constructor(readonly policyKey: string) {
    super(CHANNEL_RESTRICTED_NOTICE);
    this.name = "ChannelRestrictedError";
  }
}

/** Is `err` (or a cause) the chat refusal? */
export function isChannelRestricted(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth += 1) {
    if ((current as { code?: unknown }).code === CHANNEL_RESTRICTED_CODE) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The stamp a fusion worker carries: the policy of the turn fanning it
 * out (the frame running now), `null` for an unconstrained parent, and
 * absent when nothing scoped the fan-out (the worker then fails closed).
 */
export function workerPolicyStampFromFrame(): ProviderPolicyStamp | null | undefined {
  const frame = currentProviderPolicyFrame();
  if (frame === undefined) return undefined;
  return frame.policy === undefined ? null : toProviderPolicyStamp(frame.policy);
}

/**
 * Why a task's notification, or a chat adapter's send (reply, progress,
 * notices, files, an approval prompt's details), may not go to its chat
 * right now, or `null` (issue #33): its session's policy, read at send
 * time through
 * `effectivePolicyForSession`, must list "channels". A task with no
 * session while constraints exist is refused (fail closed).
 */
export function channelNotifyRefusal(
  policy: Pick<SessionProviderPolicy, "constraintsActive" | "effectivePolicyForSession">,
  session: string | { id: string; workingDir: string; metadata?: Record<string, unknown> } | null,
): string | null {
  if (session === null) {
    return policy.constraintsActive() ? "provider constraints are configured and the task has no session" : null;
  }
  return egressRefusal(policy, session, "channels");
}

/**
 * Why `session`'s content may not leave this machine through `cls`
 * right now, or `null` (issue #33), read through
 * `effectivePolicyForSession`: `"channels"` for a chat, `"serve"` for an
 * HTTP server listening on a network address, `"github"` for an issue
 * report.
 */
export function egressRefusal(
  policy: Pick<SessionProviderPolicy, "constraintsActive" | "effectivePolicyForSession">,
  session: string | { id: string; workingDir: string; metadata?: Record<string, unknown> },
  cls: string,
): string | null {
  if (!policy.constraintsActive()) return null;
  const effective = policy.effectivePolicyForSession(session);
  if (effective === undefined || effective.allowsEgress(cls)) return null;
  return `folder ${effective.key} is restricted; "${cls}" is not in its allowedEgress`;
}

/**
 * What a session created by another session's tool (`tasks.schedule
 * { newSession: true }`, `tasks.cron`) starts from (issue #33): the
 * caller's folder, never the runtime's, and the caller's effective
 * policy (folder plus read taint, read through
 * `effectivePolicyForSession`) stored as the new session's read taint,
 * so the task obeys the caller's constraint wherever it runs. A caller
 * that resolves to nothing while constraints exist gives a refuse-all
 * taint (fail closed). With no constraint configured nothing is added.
 */
export function childSessionSeed(
  policy: Pick<SessionProviderPolicy, "constraintsActive" | "effectivePolicyForSession">,
  parent: { sessionId: string; workingDir: string },
): { workingDir: string; metadata: Record<string, unknown> } {
  if (!policy.constraintsActive()) return { workingDir: parent.workingDir, metadata: {} };
  const effective = policy.effectivePolicyForSession(parent.sessionId);
  if (effective === undefined) return { workingDir: parent.workingDir, metadata: {} };
  return { workingDir: parent.workingDir, metadata: { [READ_TAINT_METADATA_KEY]: toProviderPolicyStamp(effective) } };
}

/**
 * A stored session moved to another folder (issue #68): the session and
 * the restriction it keeps. Moving never widens what a session may
 * reach: its transcript already holds whatever its folder governed
 * (pasted text, shell output, model output) without any read having
 * tainted it. So when the session's policy right now (its folder
 * intersected with its read taint) is restricted, that policy rides with
 * it as its read taint (`providerReadTaint`, the same stamp, intersection,
 * `/resume` persistence and memory scoping), with the old folder named in
 * `readFrom`, and the new folder's own constraint intersects with it. An
 * unrestricted session, or a move inside the same constraint entry,
 * changes only the folder. With no constraint configured nothing is added.
 */
export function moveSessionFolder<T extends { id: string; workingDir: string; metadata?: Record<string, unknown> }>(
  policy: Pick<SessionProviderPolicy, "constraintsActive" | "forSession" | "forWorkingDir">,
  session: T,
  workingDir: string,
): { session: T; kept: ProviderPolicy | undefined; policy: ProviderPolicy | undefined } {
  const plain = { ...session, workingDir };
  if (!policy.constraintsActive()) return { session: plain, kept: undefined, policy: undefined };
  const current = policy.forSession(session);
  const destination = policy.forWorkingDir(workingDir);
  if (current === undefined || (destination !== undefined && policyCovers(destination, current))) {
    return { session: plain, kept: undefined, policy: policy.forSession(plain) };
  }
  const oldFolder = policy.forWorkingDir(session.workingDir);
  const readFrom = [...new Set([...(current.readFrom ?? []), ...(oldFolder === undefined ? [] : [oldFolder.key])])];
  const carried = makeProviderPolicy({ ...current, readFrom });
  const previous = readTaintOf(session.metadata);
  const taint = previous === undefined ? carried : intersectProviderPolicies(previous, carried);
  const moved = { ...plain, metadata: { ...(session.metadata ?? {}), [READ_TAINT_METADATA_KEY]: toProviderPolicyStamp(taint) } };
  return { session: moved, kept: carried, policy: policy.forSession(moved) };
}

/** What a Retry card knows about the chat its original task ran in (`IdeaTaskCarry`). */
export type RetrySource =
  | { kind: "session"; session: { id: string; workingDir: string; metadata?: Record<string, unknown> } }
  /** The original task never had a chat: it ran in the default folder, as the rerun will. */
  | { kind: "none" }
  /** The original task, or its chat, is gone: its restriction cannot be known. */
  | { kind: "missing" };

export const RETRY_RESTRICTION_UNKNOWN =
  "the chat this retry comes from is gone, so its folder restriction cannot be checked; start a new task instead";

/**
 * The metadata a Retry card's new chat starts with (issue #68): the
 * original chat's restriction (its folder's constraint and read taint),
 * carried the way `moveSessionFolder` carries it into `workingDir`, so a
 * rerun opened in another folder (the original one is gone) or a fresh
 * chat in the same folder never widens what the prompt may reach.
 * `restricted` says whether a taint was added. A source whose chat is
 * gone is refused while constraints exist (fail closed). With no
 * constraint configured nothing is added.
 */
export function retrySessionSeed(
  policy: Pick<SessionProviderPolicy, "constraintsActive" | "forSession" | "forWorkingDir">,
  source: RetrySource,
  workingDir: string,
): { ok: true; metadata: Record<string, unknown>; restricted: boolean } | { ok: false; error: string } {
  if (!policy.constraintsActive() || source.kind === "none") return { ok: true, metadata: {}, restricted: false };
  if (source.kind === "missing") return { ok: false, error: RETRY_RESTRICTION_UNKNOWN };
  const moved = moveSessionFolder(policy, source.session, workingDir);
  const stamp = moved.session.metadata?.[READ_TAINT_METADATA_KEY];
  // Within the same constraint entry the original's stored taint (if any) still applies.
  const taint = stamp ?? source.session.metadata?.[READ_TAINT_METADATA_KEY];
  return taint === undefined
    ? { ok: true, metadata: {}, restricted: false }
    : { ok: true, metadata: { [READ_TAINT_METADATA_KEY]: taint }, restricted: true };
}

/** The `RetrySource` of an accepted idea's carry (`retry`: it is a Retry card). */
export function retrySourceOf(
  retry: boolean,
  carry: { sourceSession: { id: string; workingDir: string; metadata?: Record<string, unknown> } | null; sourceSessionMissing: boolean } | null,
): RetrySource | null {
  if (!retry) return null;
  if (carry === null || carry.sourceSessionMissing) return { kind: "missing" };
  return carry.sourceSession === null ? { kind: "none" } : { kind: "session", session: carry.sourceSession };
}
