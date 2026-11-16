import type { ContractCheckResult, ContractCheckRunner } from "./contract-checks.js";

/**
 * The folder's egress rule for contract checks (issue #40).
 *
 * A contract check is a `verify.run` spec, but the fan-out runs it
 * through the verify family directly, not through the tool registry, so
 * the registry's dispatch guard (`tool-egress.ts`: a page run is class
 * `browser`, a networked command is refused best effort) never saw it.
 * `refuse` is that same guard, asked for `verify.run` with the spec, as
 * the delegating session: a spec it refuses never reaches the runner
 * (nor the operator's approval prompt) and comes back as a red result
 * carrying the guard's message. The rest of the batch runs as before.
 *
 * `kind`/`type` and `cmd`/`command` are read both ways before the guard
 * sees the spec, so an alternative spelling cannot slip past it.
 */
export type ContractCheckEgressRule = (spec: Record<string, unknown>) => Error | null;

function guardedShape(spec: Record<string, unknown>): Record<string, unknown> {
  const kind = spec.kind ?? spec.type;
  const cmd = spec.cmd ?? spec.command;
  return { ...spec, ...(kind === undefined ? {} : { kind }), ...(cmd === undefined ? {} : { cmd }) };
}

function refusedResult(spec: Record<string, unknown>, error: Error): ContractCheckResult {
  const kind = typeof (spec.kind ?? spec.type) === "string" ? String(spec.kind ?? spec.type) : "command";
  return { ok: false, error: error.message, summary: `verify.run ${kind}: REFUSED\n${error.message}` };
}

/** `runner` with `refuse` applied per spec; `runner` itself when there is no rule. */
export function withContractCheckEgress(
  runner: ContractCheckRunner | undefined,
  refuse: ContractCheckEgressRule | undefined,
): ContractCheckRunner | undefined {
  if (runner === undefined || refuse === undefined) return runner;
  const wrapped = async (
    specs: Parameters<ContractCheckRunner>[0],
    ctx: Parameters<ContractCheckRunner>[1],
  ): ReturnType<ContractCheckRunner> => {
    const refusals = specs.map((spec) => refuse(guardedShape(spec)));
    if (refusals.every((r) => r === null)) return runner(specs, ctx);
    const allowed = specs.filter((_, i) => refusals[i] === null);
    const ran = allowed.length === 0 ? { ok: true, results: [] as readonly ContractCheckResult[] } : await runner(allowed, ctx);
    let next = 0;
    const results = specs.map((spec, i): ContractCheckResult => {
      const refusal = refusals[i];
      if (refusal !== null && refusal !== undefined) return refusedResult(spec, refusal);
      const result = ran.results[next];
      next += 1;
      return result ?? { ok: false, error: "the runner returned no result" };
    });
    return { ok: false, results };
  };
  return Object.assign(wrapped, runner.supportsInputIntegrity === true ? { supportsInputIntegrity: true as const } : {});
}

/** The specs `refuse` lets through, for an authorization asked before running. */
export function contractChecksAllowedByEgress<T extends Record<string, unknown>>(
  specs: readonly T[],
  refuse: ContractCheckEgressRule | undefined,
): T[] {
  return refuse === undefined ? [...specs] : specs.filter((spec) => refuse(guardedShape(spec)) === null);
}
