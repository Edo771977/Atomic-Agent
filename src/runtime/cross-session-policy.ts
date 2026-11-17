import { currentProviderPolicy, intersectProviderPolicies, type ProviderPolicy } from "../llm/provider-policy.js";
import { constraintScopeOf, scopeVisibleTo } from "../memory/memory-constraint-scope.js";
import type { SessionProviderPolicy } from "./session-provider-policy.js";
import type { SessionReadTaint } from "./session-read-taint.js";

/**
 * Per-folder provider constraints (issue #33) on the cross-chat tools
 * (`sessions.read` / `send` / `check`, ATO-570; `memory.sessions.search`,
 * ATO-1151). Another chat's transcript is that chat's content, so it is
 * governed by that chat's policy (its folder's constraint intersected
 * with its own read taint):
 *
 * - reading it (`sessions.read`, a `sessions.check` answer, a
 *   `memory.sessions.search` read of one session) taints the reader like
 *   a file read inside that folder (`session-read-taint.ts`);
 * - a search lists a chat only when the caller could see a memory row
 *   written under that chat's policy (memory scoping,
 *   `memory-constraint-scope.ts`), so a snippet never leaks;
 * - a message queued into another chat (`sessions.send`) carries the
 *   sender's policy as the target's read taint, so the target's turn
 *   cannot send the sender's constrained content where its folder may not.
 *
 * Every check reads the live config; without constraints nothing happens.
 */
export interface CrossSessionPolicy {
  /** Whether the call running now may list `targetSessionId`'s lines in a search. */
  visible(targetSessionId: string): boolean;
  /** `callerSessionId` is about to read `targetSessionId`'s transcript. */
  noteRead(callerSessionId: string, targetSessionId: string): void;
  /** A message from `callerSessionId` is about to be queued into `targetSessionId`. */
  carryTo(callerSessionId: string, targetSessionId: string): void;
}

export function createCrossSessionPolicy(deps: {
  policy: Pick<SessionProviderPolicy, "constraintsActive" | "forSessionId" | "forSession" | "effectivePolicyForSession">;
  readTaint: Pick<SessionReadTaint, "noteContent" | "taintSession" | "liveSession">;
}): CrossSessionPolicy {
  /** The target's own policy: its stored row and, while it runs, its live (possibly unsaved) taint. */
  const targetPolicy = (sessionId: string): ProviderPolicy | undefined => {
    let policy = deps.policy.forSessionId(sessionId);
    const live = deps.readTaint.liveSession<{ id: string; workingDir: string; metadata?: Record<string, unknown> }>(sessionId);
    const livePolicy = live === undefined ? undefined : deps.policy.forSession(live);
    if (livePolicy !== undefined) policy = policy === undefined ? livePolicy : intersectProviderPolicies(policy, livePolicy);
    return policy;
  };
  return {
    visible(targetSessionId) {
      if (!deps.policy.constraintsActive()) return true;
      const target = targetPolicy(targetSessionId);
      return target === undefined || scopeVisibleTo(constraintScopeOf(target), currentProviderPolicy());
    },
    noteRead(callerSessionId, targetSessionId) {
      if (callerSessionId === targetSessionId || !deps.policy.constraintsActive()) return;
      const target = targetPolicy(targetSessionId);
      if (target !== undefined) deps.readTaint.noteContent(callerSessionId, target);
    },
    carryTo(callerSessionId, targetSessionId) {
      if (callerSessionId === targetSessionId || !deps.policy.constraintsActive()) return;
      const caller = deps.policy.effectivePolicyForSession(callerSessionId);
      if (caller !== undefined) deps.readTaint.taintSession(targetSessionId, caller);
    },
  };
}
