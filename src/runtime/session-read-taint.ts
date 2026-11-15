import type { AtomicAgentConfig } from "../config/index.js";
import {
  currentProviderPolicy,
  currentProviderPolicyCell,
  hasProjectConstraints,
  intersectProviderPolicies,
  makeProviderPolicy,
  policyCovers,
  providerPolicyFromStamp,
  resolveProjectConstraint,
  tightenCurrentProviderPolicy,
  toProviderPolicyStamp,
  type ProviderPolicy,
  type ProviderPolicyCell,
} from "../llm/provider-policy.js";
import { readFusionWorkerMeta } from "../session/fusion-worker-session.js";
import { readTaintTargets } from "../tools/read-scope/index.js";

/** Session metadata key of the sticky read taint (a `ProviderPolicyStamp`). */
export const READ_TAINT_METADATA_KEY = "providerReadTaint";

interface TaintableSession {
  id: string;
  metadata?: Record<string, unknown>;
}

/** The read taint stored on a session, or `undefined` (none, or unreadable: see below). */
export function readTaintOf(metadata: Record<string, unknown> | undefined): ProviderPolicy | undefined {
  const raw = metadata?.[READ_TAINT_METADATA_KEY];
  if (raw === undefined) return undefined;
  // An unreadable stamp fails closed: nothing may serve the session.
  return providerPolicyFromStamp(raw) ??
    makeProviderPolicy({ key: "(unreadable read taint)", allowedProviders: [], matchedDir: "", readFrom: ["(unknown)"] });
}

export interface SessionReadTaintDeps {
  /** The live config (`getConfig`), read on every call. */
  readConfig: () => Pick<AtomicAgentConfig, "projects">;
  /** Persist a session that is not running a turn now (load, patch, save). */
  patchStoredSession?: (sessionId: string, patch: (metadata: Record<string, unknown>) => Record<string, unknown>) => void;
  /**
   * Whether the after-edit language servers were built at boot
   * (`tools.lsp.enabled` as `registerOsTools` read it). Only then can a
   * write's result quote its project, so only then does a write taint.
   */
  lspWrites?: boolean;
}

/**
 * Read taint for per-folder provider constraints (issue #33 group C).
 *
 * A session that reads files inside a constrained folder (its own
 * folder is unconstrained, or less constrained) carries that folder's
 * constraint from then on: the strictest matched list (the intersection
 * when several folders were read). It is set at tool dispatch, before
 * the read runs, like the untrusted-content taint (`untrusted-taint.ts`)
 * and the read scope: never by prompt wording.
 *
 * - The turn's live policy frame is tightened at once, so the next model
 *   call of the same turn (and a model-calling read like
 *   `vision.describe`) must satisfy it.
 * - It is stored in the session's metadata (`providerReadTaint`), so the
 *   next turn, side calls by session id and `/resume` keep it
 *   (`session-provider-policy.ts` intersects it with the folder's own).
 * - A Fusion worker hands what it read back to its orchestrator, so the
 *   orchestrator's turn is tainted too.
 *
 * A read the read scope then refuses still taints (fail closed).
 */
export function createSessionReadTaint(deps: SessionReadTaintDeps) {
  const live = new Map<string, { session: TaintableSession; cell: ProviderPolicyCell | undefined }>();

  const persist = (sessionId: string, taint: ProviderPolicy): void => {
    const turn = live.get(sessionId);
    const merge = (metadata: Record<string, unknown>): Record<string, unknown> => {
      const previous = readTaintOf(metadata);
      const next = previous === undefined ? taint : intersectProviderPolicies(previous, taint);
      return { ...metadata, [READ_TAINT_METADATA_KEY]: toProviderPolicyStamp(next) };
    };
    if (turn !== undefined) {
      // The turn saves its own state at its next checkpoint and at its end.
      turn.session.metadata = merge(turn.session.metadata ?? {});
      if (turn.cell !== undefined && turn.cell !== currentProviderPolicyCell()) {
        tightenCurrentProviderPolicy(taint, turn.cell);
      }
      return;
    }
    try {
      deps.patchStoredSession?.(sessionId, merge);
    } catch {
      // The live frame is tightened already; the store may be closing.
    }
  };

  /** The taint reading `targets` would add to `current`, or `undefined` when it adds nothing. */
  const taintFor = (targets: readonly string[], current: ProviderPolicy | undefined): ProviderPolicy | undefined => {
    const config = deps.readConfig();
    let taint: ProviderPolicy | undefined;
    for (const target of targets) {
      const matched = resolveProjectConstraint(config, target);
      if (matched === undefined) continue;
      if (current !== undefined && policyCovers(current, matched)) continue;
      const read = makeProviderPolicy({ ...matched, readFrom: [matched.key] });
      taint = taint === undefined ? read : intersectProviderPolicies(taint, read);
    }
    return taint;
  };

  return {
    /**
     * Run a turn's body with `session` registered as live, so a taint set
     * by one of its tools lands on the object the turn saves. `cell` is
     * the turn's policy frame.
     */
    async inTurn<T>(session: TaintableSession, run: () => Promise<T>): Promise<T> {
      const previous = live.get(session.id);
      live.set(session.id, { session, cell: currentProviderPolicyCell() });
      try {
        return await run();
      } finally {
        if (previous === undefined) live.delete(session.id);
        else live.set(session.id, previous);
      }
    },

    /** The object the running turn holds for `sessionId`, if one runs (its metadata carries an unsaved taint). */
    liveSession<T extends TaintableSession = TaintableSession>(sessionId: string): T | undefined {
      return live.get(sessionId)?.session as T | undefined;
    },

    /**
     * Called by the tool registry before a tool runs (`onDispatch`).
     * Returns the taint applied, for tests and status.
     */
    noteDispatch(tool: string, args: Record<string, unknown>, ctx: { sessionId: string; workingDir: string }): ProviderPolicy | undefined {
      if (!hasProjectConstraints(deps.readConfig())) return undefined;
      const targets = readTaintTargets(tool, args, ctx.workingDir, { lspWrites: deps.lspWrites === true });
      if (targets.length === 0) return undefined;
      const taint = taintFor(targets, currentProviderPolicy());
      if (taint === undefined) return undefined;
      tightenCurrentProviderPolicy(taint);
      persist(ctx.sessionId, taint);
      // A worker's findings reach its orchestrator as text.
      let session = live.get(ctx.sessionId)?.session;
      for (let hops = 0; session !== undefined && hops < 4; hops += 1) {
        const parent = readFusionWorkerMeta(session.metadata)?.parentSessionId;
        if (parent === undefined) break;
        persist(parent, taint);
        session = live.get(parent)?.session;
      }
      return taint;
    },
  };
}

export type SessionReadTaint = ReturnType<typeof createSessionReadTaint>;
