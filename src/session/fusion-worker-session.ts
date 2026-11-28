import { randomUUID } from "node:crypto";
import { createEmptySessionState, type SessionState } from "./session-state.js";

/**
 * Ephemeral sessions for fusion workers.
 *
 * In fusion mode a cloud orchestrator turn fans subtasks out to local
 * model workers running concurrently in the same process. Each worker
 * needs a `SessionState` of its own — the turn controller's per-session
 * FIFO, slot affinity, approvals and steering are all keyed by session
 * id — but nothing about it is the operator's: it is never saved, never
 * listed, never reflected on. The orchestrator reads the worker's reply
 * once and discards the state. The metadata stamp below is how the
 * runtime tells such a session apart from a real one on every path that
 * would otherwise persist or trace it.
 */

/** Reserved `SessionState.metadata` key the worker stamp lives under. */
export const FUSION_WORKER_METADATA_KEY = "fusionWorker";

/** Worker session ids start with this; a real session's start with `s-`. */
export const FUSION_WORKER_ID_PREFIX = "s-w-";

export interface FusionWorkerMeta {
  /** The session whose orchestrator turn spawned this worker. */
  parentSessionId: string;
  /** The orchestrator's task id for this subtask (its own bookkeeping). */
  taskId: string;
  /** Operator = 0; a worker has its parent depth plus one. Legacy workers default to 1. */
  depth?: number;
  /**
   * The operator's request the fan-out quotes, unclipped. A local
   * worker's brief quotes only its first 6,000 chars, but the input
   * guard must protect every file the whole request names, so
   * `executeTurn` records this in place of the brief's clipped quote.
   */
  operatorRequest?: string;
  /**
   * The provider policy of the parent's turn at fan-out (issue #33):
   * the folder constraint the worker must obey wherever it runs, a temp
   * copy included. `null`: the parent's folder is unconstrained. Absent:
   * nothing stamped it, and the runtime refuses the worker every provider
   * while any constraint exists. Never re-derived from the worker folder.
   */
  providerPolicy?: WorkerProviderPolicyStamp | null;
}

/** Only depth is required on read; fork request and policy fields stay optional. */
export type StampedFusionWorkerMeta = FusionWorkerMeta & { depth: number };

export const FUSION_WORKER_DEFAULT_DEPTH = 1;

function isValidDepth(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/** The serialisable provider policy a worker carries (`ProviderPolicyStamp`). */
export interface WorkerProviderPolicyStamp {
  key: string;
  allowedProviders: string[];
  /** Egress classes the parent's folder allows; absent (an older stamp) = none. */
  allowedEgress?: string[];
  /** Other machines a local provider may be reached at (issue #60); absent = none. */
  allowedProviderHosts?: string[];
  matchedDir: string;
}

function readPolicyStamp(raw: unknown): WorkerProviderPolicyStamp | null | undefined | "malformed" {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return "malformed";
  const { key, allowedProviders, allowedEgress, allowedProviderHosts, matchedDir } = raw as Record<string, unknown>;
  if (typeof key !== "string" || typeof matchedDir !== "string" || !Array.isArray(allowedProviders)
    || !allowedProviders.every((id) => typeof id === "string")) return "malformed";
  const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((c) => typeof c === "string");
  if (allowedEgress !== undefined && !isStrings(allowedEgress)) return "malformed";
  if (allowedProviderHosts !== undefined && !isStrings(allowedProviderHosts)) return "malformed";
  return {
    key,
    allowedProviders: [...allowedProviders] as string[],
    ...(allowedEgress === undefined ? {} : { allowedEgress: [...allowedEgress] }),
    ...(allowedProviderHosts === undefined ? {} : { allowedProviderHosts: [...allowedProviderHosts] }),
    matchedDir,
  };
}

/**
 * Build a worker session in memory. Deliberately NOT persisted here and
 * not by any caller: `executeTurn` skips `sessionStore.save` for a
 * session carrying the stamp, so the id never reaches the session list.
 */
export function createFusionWorkerSession(input: {
  workingDir: string;
  meta: FusionWorkerMeta;
}): SessionState {
  return createEmptySessionState({
    id: `${FUSION_WORKER_ID_PREFIX}${randomUUID()}`,
    workingDir: input.workingDir,
    metadata: { [FUSION_WORKER_METADATA_KEY]: {
      ...input.meta,
      depth: isValidDepth(input.meta.depth) ? input.meta.depth : FUSION_WORKER_DEFAULT_DEPTH,
    } },
  });
}

/**
 * Read the worker stamp back out of session metadata. Defensive on
 * purpose, like `readSessionLlmStamp`: metadata is a free-form JSON bag,
 * so a malformed value degrades to "not a worker" — the safe direction,
 * since treating a real session as a worker would drop its save.
 */
export function readFusionWorkerMeta(
  metadata: Record<string, unknown> | undefined,
): StampedFusionWorkerMeta | null {
  const raw = metadata?.[FUSION_WORKER_METADATA_KEY];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const { parentSessionId, taskId, operatorRequest, providerPolicy, depth: rawDepth } = raw as {
    parentSessionId?: unknown;
    taskId?: unknown;
    depth?: unknown;
    operatorRequest?: unknown;
    providerPolicy?: unknown;
  };
  if (typeof parentSessionId !== "string" || parentSessionId.length === 0) {
    return null;
  }
  if (typeof taskId !== "string" || taskId.length === 0) return null;
  // A malformed policy stamp reads as a policy that allows nothing: the
  // worker is still a worker (its save must stay skipped), and it fails
  // closed rather than open.
  const stamp = readPolicyStamp(providerPolicy);
  const policy = stamp === "malformed"
    ? { providerPolicy: { key: "(unreadable fusion worker policy)", allowedProviders: [], allowedEgress: [], matchedDir: "" } }
    : stamp === undefined ? {} : { providerPolicy: stamp };
  const depth = isValidDepth(rawDepth) ? rawDepth : FUSION_WORKER_DEFAULT_DEPTH;
  return typeof operatorRequest === "string"
    ? { parentSessionId, taskId, depth, operatorRequest, ...policy }
    : { parentSessionId, taskId, depth, ...policy };
}

export function readSessionDepth(metadata: Record<string, unknown> | undefined): number {
  return readFusionWorkerMeta(metadata)?.depth ?? 0;
}

export function childFusionWorkerDepth(parentMetadata: Record<string, unknown> | undefined): number {
  return readSessionDepth(parentMetadata) + 1;
}

/** Whether `id` was minted by `createFusionWorkerSession`. */
export function isFusionWorkerSessionId(id: string): boolean {
  return id.startsWith(FUSION_WORKER_ID_PREFIX);
}
