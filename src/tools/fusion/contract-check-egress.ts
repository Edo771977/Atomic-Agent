import { EgressNotAllowedError, isNetworkedResearch } from "../tool-egress.js";
import type { ContractCheckResult, ContractCheckRun, ContractCheckRunner } from "./contract-checks.js";

/**
 * The folder's egress rule for contract checks (issue #40).
 *
 * A contract check is a `verify.run` spec, but the fan-out runs it
 * through the verify family directly, not through the tool registry, so
 * the registry's dispatch guard (`tool-egress.ts`) never saw it. A page
 * or rendered UI check is browser egress, and research link probes use HTTP egress.
 * `refuse` is that same guard, asked for `verify.run` with the spec, as
 * the delegating session: a spec it refuses never reaches the runner
 * (nor the operator's approval prompt) and comes back with the guard's
 * message. For research, only the network portion is withheld, so local
 * citation evidence and the unverified links can still be reported.
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

function offlineResearch<T extends Record<string, unknown>>(spec: T, refusal: Error | null): T {
  return refusal instanceof EgressNotAllowedError && refusal.egressClass === "http" && isNetworkedResearch("verify.run", spec)
    ? { ...spec, network: false } : spec;
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
    const egress = specs.map(spec => refuse(guardedShape(spec)));
    if (egress.every(refusal => refusal === null)) return runner(specs, ctx);
    const effective = specs.map((spec, index) => offlineResearch(spec, egress[index]!));
    const refusals = egress.map((refusal, index) => effective[index] === specs[index] ? refusal : null);
    const allowed = effective.filter((_, i) => refusals[i] === null);
    const checkTasks = ctx.checkTasks?.filter((_, i) => refusals[i] === null);
    const ran = allowed.length === 0
      ? { ok: true, results: [] as readonly ContractCheckResult[] }
      : await runner(allowed, { ...ctx, ...(checkTasks === undefined ? {} : { checkTasks }) });
    let next = 0;
    const results = specs.map((spec, i): ContractCheckResult => {
      const refusal = refusals[i];
      if (refusal !== null && refusal !== undefined) return refusedResult(spec, refusal);
      const result = ran.results[next++];
      if (result === undefined) return { ok: false, error: "the runner returned no result" };
      const networkRefusal = egress[i];
      if (!result.ok && networkRefusal != null && spec !== effective[i]) {
        const reason = `Research link probes skipped: ${networkRefusal.message}`;
        return { ...result, error: [reason, result.error].filter(Boolean).join("\n"), summary: [result.summary, reason].filter(Boolean).join("\n") };
      }
      return result;
    });
    return { ok: ran.ok && results.every(result => result.ok), results };
  };
  return Object.assign(wrapped, runner.supportsInputIntegrity === true ? { supportsInputIntegrity: true as const } : {});
}

/** The specs `refuse` lets through, for an authorization asked before running. */
export function contractChecksAllowedByEgress<T extends Record<string, unknown>>(
  specs: readonly T[],
  refuse: ContractCheckEgressRule | undefined,
): T[] {
  if (refuse === undefined) return [...specs];
  return specs.flatMap(spec => {
    const refusal = refuse(guardedShape(spec));
    const effective = offlineResearch(spec, refusal);
    return refusal === null || effective !== spec ? [effective] : [];
  });
}

/**
 * `runner` told which fusion run its checks belong to (`run()`, read
 * per call: the run's checkpoint starts after the runner is built), so a
 * page check's screenshots are kept with the run (issue #40). A ctx that
 * already names a run keeps it.
 */
export function withCheckRun(
  runner: ContractCheckRunner | undefined,
  run: () => ContractCheckRun | undefined,
): ContractCheckRunner | undefined {
  if (runner === undefined) return undefined;
  const wrapped = (specs: Parameters<ContractCheckRunner>[0], ctx: Parameters<ContractCheckRunner>[1]): ReturnType<ContractCheckRunner> => {
    const current = ctx.run ?? run();
    return runner(specs, current === undefined ? ctx : { ...ctx, run: current });
  };
  return Object.assign(wrapped, runner.supportsInputIntegrity === true ? { supportsInputIntegrity: true as const } : {});
}

/** Restore service dependencies when Fusion selects only part of the declared checks. */
export function withContractCheckServices(
  runner: ContractCheckRunner | undefined,
  declared: readonly Record<string, unknown>[],
  refuse?: ContractCheckEgressRule,
): ContractCheckRunner | undefined {
  if (runner === undefined) return undefined;
  const known = new Map(declared.flatMap(spec =>
    (spec.kind ?? spec.type) === "service" && typeof spec.id === "string" ? [[spec.id, spec] as const] : []));
  if (known.size === 0) return runner;
  const wrapped: ContractCheckRunner = async (specs, ctx) => {
    const selected = new Map(specs.flatMap((spec, index) =>
      (spec.kind ?? spec.type) === "service" && typeof spec.id === "string" ? [[spec.id, index] as const] : []));
    const included = new Set<string>();
    const expanded: Record<string, unknown>[] = [];
    const tasks: (string | undefined)[] = [];
    const positions = specs.map(() => -1);
    const append = (spec: Record<string, unknown>, task?: string, originalIndex?: number) => {
      if (originalIndex !== undefined) positions[originalIndex] = expanded.length;
      expanded.push(spec);
      tasks.push(task);
    };
    for (const [index, spec] of specs.entries()) {
      if (positions[index] !== -1) continue;
      const kind = spec.kind ?? spec.type;
      if (kind === "service" && typeof spec.id === "string") included.add(spec.id);
      if (kind === "ui" && typeof spec.service === "string" && !included.has(spec.service) &&
          (refuse === undefined || refuse(guardedShape(spec)) === null)) {
        const serviceIndex = selected.get(spec.service);
        const dependency = known.get(spec.service);
        if (serviceIndex !== undefined) {
          append(specs[serviceIndex]!, ctx.checkTasks?.[serviceIndex], serviceIndex);
          included.add(spec.service);
        } else if (dependency !== undefined) {
          const { task, criteria: _criteria, judge: _judge, negative: _negative, ...service } = dependency;
          append(service, typeof task === "string" ? task : undefined);
          included.add(spec.service);
        }
      }
      append(spec, ctx.checkTasks?.[index], index);
    }
    if (expanded.length === specs.length && positions.every((position, index) => position === index)) return runner(specs, ctx);
    const ran = await runner(expanded, { ...ctx, checkTasks: tasks });
    const results = positions.map(position => ran.results[position] ?? { ok: false, error: "the runner returned no result" });
    return { ok: ran.ok && results.every(result => result.ok), results };
  };
  return Object.assign(wrapped, runner.supportsInputIntegrity ? { supportsInputIntegrity: true as const } : {});
}
