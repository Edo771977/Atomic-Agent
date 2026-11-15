import type { AtomicAgentConfig } from "../config/index.js";
import {
  hasProjectConstraints,
  makeProviderPolicy,
  providerPolicyFromStamp,
  resolveProjectConstraint,
  toProviderPolicyStamp,
  currentProviderPolicyFrame,
  type ProviderPolicy,
  type ProviderPolicyStamp,
} from "../llm/provider-policy.js";
import { readFusionWorkerMeta } from "../session/fusion-worker-session.js";

/** The policy that lets no provider serve: what an unscoped caller gets while constraints exist. */
export function refuseAllPolicy(key: string, matchedDir = ""): ProviderPolicy {
  return makeProviderPolicy({ key, allowedProviders: [], matchedDir });
}

export interface SessionProviderPolicyDeps {
  /** The live config (`getConfig`), read on every call so an edit lands. */
  readConfig: () => Pick<AtomicAgentConfig, "projects">;
  /** A stored session's folder and metadata, or null when there is none. */
  loadSession: (sessionId: string) => { workingDir: string; metadata?: Record<string, unknown> } | null;
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
 * - An id that names no stored session while constraints exist: refused
 *   everything (fail closed).
 */
export function createSessionProviderPolicy(deps: SessionProviderPolicyDeps) {
  const constraintsActive = (): boolean => hasProjectConstraints(deps.readConfig());
  const forWorkingDir = (workingDir: string): ProviderPolicy | undefined =>
    resolveProjectConstraint(deps.readConfig(), workingDir);
  const forSession = (session: { id: string; workingDir: string; metadata?: Record<string, unknown> }): ProviderPolicy | undefined => {
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
  return { constraintsActive, forWorkingDir, forSession, forSessionId };
}

export type SessionProviderPolicy = ReturnType<typeof createSessionProviderPolicy>;

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
