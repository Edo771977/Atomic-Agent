import { findConstraintRefusal, formatConstraintRefusal } from "../runtime/constraint-refusal.js";

/**
 * The `session_failed` event's payload. `error` and `category` are as
 * before; a turn a per-folder constraint refused also carries the stable
 * `code` (`ATOMIC_AGENT_PROVIDER_NOT_ALLOWED` /
 * `ATOMIC_AGENT_EGRESS_NOT_ALLOWED`) and `advice`, the sentence and hint
 * the TUI and CLI show, so a host does not report it as a provider
 * failure.
 */
export function sessionFailedPayload(
  sessionId: string,
  error: Error,
  category: string,
  opts: { localModelConfigured: boolean },
): { sessionId: string; error: string; category: string; code?: string; advice?: string } {
  const base = { sessionId, error: error.message, category };
  const constraint = findConstraintRefusal(error);
  if (constraint === null) return base;
  return {
    ...base,
    code: constraint.code,
    advice: formatConstraintRefusal(constraint, opts).replace(/\n\s*/g, " — "),
  };
}
