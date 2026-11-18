import { isDeepStrictEqual } from "node:util";
import { intersectProviderPolicies, providerPolicyFromStamp, toProviderPolicyStamp } from "../llm/provider-policy.js";

/**
 * Session metadata key of the sticky read taint (a `ProviderPolicyStamp`,
 * issue #33 group C; `runtime/session-read-taint.ts` sets it). The
 * restriction a moved chat or a Retry card's chat keeps (issue #68) is
 * stored under the same key.
 */
export const READ_TAINT_METADATA_KEY = "providerReadTaint";

/**
 * The stricter of two stored read-taint stamps: their intersection.
 * `undefined` stands for no stamp. An unreadable stamp wins as it is,
 * since reading it fails closed (nothing may serve the session).
 */
export function mergeReadTaintStamps(a: unknown, b: unknown): unknown {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const left = providerPolicyFromStamp(a);
  if (left === undefined) return a;
  const right = providerPolicyFromStamp(b);
  if (right === undefined) return b;
  return toProviderPolicyStamp(intersectProviderPolicies(left, right));
}

/**
 * `next` with the read taint `carried` (a stamp, or `undefined`)
 * intersected into its own (issue #74): a taint is never dropped by a
 * write, whichever copy of the session the writer held. Returns `next`
 * itself when nothing changes.
 */
export function withReadTaintFrom<T extends { metadata: Record<string, unknown> }>(next: T, carried: unknown): T {
  if (carried === undefined) return next;
  const own = next.metadata[READ_TAINT_METADATA_KEY];
  const merged = mergeReadTaintStamps(carried, own);
  if (own !== undefined && isDeepStrictEqual(merged, own)) return next;
  return { ...next, metadata: { ...next.metadata, [READ_TAINT_METADATA_KEY]: merged } };
}
