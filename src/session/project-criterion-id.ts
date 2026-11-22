/** Shared id normalization for brief criteria, decisions and contract checks. */
export const CRITERION_ID_PATTERN = /^[a-z0-9-]{1,32}$/;
/**
 * A criterion id trimmed and lower-cased; null when it breaks
 * {@link CRITERION_ID_PATTERN}. The one rule for criterion ids: the
 * brief, milestone reports and contract checks all normalize through it,
 * so an id a check names always matches the brief's.
 */
export function normalizeCriterionId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim().toLowerCase();
  return CRITERION_ID_PATTERN.test(id) ? id : null;
}
