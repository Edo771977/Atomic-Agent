/**
 * Known session-owned routing partitions; archive keys use `/` instead of `:`.
 * complete:api (runtime/plain-complete.ts) is excluded: withFreshPrivacyVault
 * isolates each call, and with folder constraints it is intentionally refused
 * because no chat folder can govern it. See ../http/README.md.
 * GRAMMAR_SMOKE_SESSION_PREFIX (grammar-smoke:) is also excluded: its
 * synthetic grammar-protocol probe is partitioned by provider, not by chat.
 */
export const AUXILIARY_PARTITIONS = [
  "compaction", "next-step", "risk", "browser-extract", "reflection", "rewriter",
  "link-gen", "vote", "note-reconcile", "btw", "title", "enhance", "learn", "goal-judge",
] as const;

const known = new Set<string>(AUXILIARY_PARTITIONS);

export function isAuxiliaryPartition(prefix: string): boolean {
  return known.has(prefix);
}
