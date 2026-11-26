/** Known routing partitions; archive keys use `/` instead of the wire's `:`. */
export const AUXILIARY_PARTITIONS = [
  "compaction", "next-step", "risk", "browser-extract", "reflection", "rewriter",
  "link-gen", "vote", "note-reconcile", "btw", "title", "enhance", "learn", "goal-judge",
] as const;

const known = new Set<string>(AUXILIARY_PARTITIONS);

export function isAuxiliaryPartition(prefix: string): boolean {
  return known.has(prefix);
}
