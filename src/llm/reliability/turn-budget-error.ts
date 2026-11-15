/**
 * The fusion turn's USD cap (`llm.runMode.fusion.turnBudgetUsd`) refused a
 * request before anything was sent (issue #29).
 *
 * Thrown by the turn ledger's synchronous admission. A leaf module like
 * `spend-limit-error.ts`: the request scope, the agent turn recovery and
 * every surface that renders a budget stop read it, and none of them may
 * import the others. The agent loop answers it with one final no-tools
 * report step (`finalReport` on the request); the surfaces render the turn
 * as stopped by its budget rather than as a failure.
 */
export class TurnBudgetExhaustedError extends Error {
  /** The turn's cap. */
  readonly capUsd: number;
  /** Settled request charges plus carried/external spend. */
  readonly accountedUsd: number;
  /** Other requests' open holds at refusal time. */
  readonly heldUsd: number;
  /** What this request would have held (`0` for a metered send). */
  readonly requestUsd: number;

  constructor(params: { capUsd: number; accountedUsd: number; heldUsd: number; requestUsd: number }) {
    super(turnBudgetRefusalSentence(params));
    this.name = "TurnBudgetExhaustedError";
    this.capUsd = params.capUsd;
    this.accountedUsd = params.accountedUsd;
    this.heldUsd = params.heldUsd;
    this.requestUsd = params.requestUsd;
  }
}

/**
 * The refusal in words. A metered send holds nothing, so "$0.00 reserved
 * cost would exceed" said nothing useful: the cap is simply used up. A
 * real reservation keeps the detailed form, which says why it did not fit.
 */
export function turnBudgetRefusalSentence(params: { capUsd: number; accountedUsd: number; heldUsd: number; requestUsd: number }): string {
  if (params.requestUsd <= 0 && params.heldUsd <= 0) {
    return `the ${usd(params.capUsd)} turn cap is used up (${usd(params.accountedUsd)} accounted); no further requests this turn`;
  }
  return `turn budget cannot cover this request: ${usd(params.requestUsd)} reserved cost would exceed the ${usd(params.capUsd)} cap (${usd(params.accountedUsd)} accounted, ${usd(params.heldUsd)} held)`;
}

/**
 * Output ceiling of the final report a turn gets after its cap refused
 * (issue #29): the agent step asks for it and the request scope clamps to
 * it and prices its hold at it. Sized for thinking plus a short report:
 * Fable / Opus 5.5 cannot turn thinking off, and it shares this budget
 * with the text even at the report's low effort.
 */
export const FINAL_REPORT_MAX_TOKENS = 4096;

/** The short stop line every surface shows for a turn its cap ended. */
export function turnBudgetStopLine(spentUsd: number, capUsd: number): string {
  return `turn stopped: budget exhausted (${usd(spentUsd)} of ${usd(capUsd)})`;
}

/** The turn-cap refusal in `err` or one of its causes, if any. */
export function findTurnBudgetExhaustedError(err: unknown): TurnBudgetExhaustedError | null {
  let current: unknown = err;
  for (let depth = 0; depth < 6; depth += 1) {
    if (current instanceof TurnBudgetExhaustedError) return current;
    if (typeof current !== "object" || current === null) return null;
    const next = (current as { cause?: unknown }).cause;
    if (next === current) return null;
    current = next;
  }
  return null;
}

/** Same precision as the fusion ledger's `formatUsd`. */
function usd(value: number): string {
  return value > 0 && value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}
