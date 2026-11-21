/**
 * A contract check's negative control (issue #110).
 *
 * A check proves something only if it can fail. A check may say how:
 *
 *   { task: "t1", criteria: ["c1"], kind: "command", cmd: "node",
 *     args: ["sales.cjs", "good.csv"], checks: ["exit 0", "stdout contains \"…\""],
 *     negative: { args: ["sales.cjs", "bad.csv"] } }
 *
 * `negative` changes only the command's input (`args`, `stdin`, `env`);
 * the command, its assertions and everything else stay the check's own.
 * `runContractChecks` runs it first, as its own one-spec batch through
 * the same runner as the check — so the same approval (the person sees
 * the negative's command), read scope, egress rule, input integrity and
 * cancellation — and then the declared checks. A negative that passes
 * marks the check unreliable (`ContractCheckOutcome.unreliable`), and a
 * criterion it names is `unverified`, never `passed`
 * (`criteria-facts.ts`). One the approval refuses or holds throws like
 * the batch would, so no check runs. One the runner reports as not run
 * (an `error`, such as an egress refusal, or no result) is no verdict on
 * the check: the outcome's `negative` says why, the row and the contract
 * line say so, and a criterion it alone supports is `passed` with a
 * reservation. One that ran and timed out counts as failed, as any
 * failing check does.
 */

import type { ContractCheck, ContractCheckNegative } from "./contract.js";

const NEGATIVE_KEYS = new Set(["args", "stdin", "env"]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The canonical text of a value, for "the same input" comparisons. */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * `checks[i].negative` as declared, or the problem (pushed) and null.
 * Undefined when absent. Only a command check may have one, and it must
 * change the check's input.
 */
export function parseCheckNegative(
  raw: unknown,
  spec: Record<string, unknown>,
  label: string,
  problems: string[],
): ContractCheckNegative | undefined | null {
  if (raw === undefined || raw === null) return undefined;
  const at = `${label}.negative`;
  if (!isRecord(raw)) {
    problems.push(`${at} must be an object { args?, stdin?, env? }: the same command on an input that must fail`);
    return null;
  }
  const kind = spec.kind ?? spec.type ?? "command";
  if (kind !== "command") {
    problems.push(`${at} applies to command checks only (this one is a ${String(kind)} check)`);
    return null;
  }
  const unknown = Object.keys(raw).find((k) => !NEGATIVE_KEYS.has(k));
  if (unknown !== undefined) {
    problems.push(`${at}: unknown key \`${unknown}\` (a negative changes only \`args\`, \`stdin\` or \`env\`; the command stays the check's)`);
    return null;
  }
  const negative: ContractCheckNegative = {};
  if (raw.args !== undefined && raw.args !== null) {
    if (!Array.isArray(raw.args) || !raw.args.every((a) => typeof a === "string")) {
      problems.push(`${at}.args must be an array of strings`);
      return null;
    }
    const cmd = typeof spec.cmd === "string" ? spec.cmd : typeof spec.command === "string" ? spec.command : "";
    if (/\s/.test(cmd.trim())) {
      problems.push(`${at}.args needs the check's command as \`cmd\` plus \`args\`; with a one-line \`cmd\`, change \`stdin\` or \`env\` instead`);
      return null;
    }
    negative.args = [...(raw.args as string[])];
  }
  if (raw.stdin !== undefined && raw.stdin !== null) {
    if (typeof raw.stdin !== "string") {
      problems.push(`${at}.stdin must be a string`);
      return null;
    }
    negative.stdin = raw.stdin;
  }
  if (raw.env !== undefined && raw.env !== null) {
    if (!isRecord(raw.env) || !Object.values(raw.env).every((v) => typeof v === "string")) {
      problems.push(`${at}.env must be an object of strings`);
      return null;
    }
    negative.env = { ...(raw.env as Record<string, string>) };
  }
  if (Object.keys(negative).length === 0) {
    problems.push(`${at} needs \`args\`, \`stdin\` or \`env\`: the input on which the check must fail`);
    return null;
  }
  const negSpec = { ...spec, ...negativeOverrides(spec, negative) };
  if (same(negSpec.args, spec.args) && same(negSpec.stdin, spec.stdin) && same(negSpec.env, spec.env)) {
    problems.push(`${at} runs the same input as the check; give it an input the check must fail on`);
    return null;
  }
  return negative;
}

/** The fields a negative replaces on its check's spec: `env` merged over the check's. */
function negativeOverrides(spec: Record<string, unknown>, negative: ContractCheckNegative): Record<string, unknown> {
  return {
    ...(negative.args === undefined ? {} : { args: [...negative.args] }),
    ...(negative.stdin === undefined ? {} : { stdin: negative.stdin }),
    ...(negative.env === undefined ? {} : { env: { ...(isRecord(spec.env) ? spec.env : {}), ...negative.env } }),
  };
}

/** The check without its negative control: what the declared run executes. */
export function withoutNegative<T extends Record<string, unknown>>(check: T): Omit<T, "negative"> {
  const { negative: _negative, ...rest } = check;
  return rest;
}

/**
 * The negative control's own spec, attributed to the check's task (no
 * criteria, no judge: it proves nothing by passing); undefined for a
 * check without one.
 */
export function negativeCheckOf(check: ContractCheck): ContractCheck | undefined {
  const negative = check.negative;
  if (!isRecord(negative)) return undefined;
  const { negative: _n, criteria: _c, judge: _j, ...spec } = check;
  return { ...spec, ...negativeOverrides(spec, negative as ContractCheckNegative) };
}

/**
 * A batch as an authorization plan (`contract-check-hold.ts`): every
 * check with a negative control becomes its negative's spec and then
 * itself without the field, so the person approving sees the command
 * the negative will run, and no executor field goes unexamined.
 */
export function withNegativeControls(batch: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return batch.flatMap((spec) => {
    const negative = negativeCheckOf(spec as ContractCheck);
    return negative === undefined ? [spec] : [negative, withoutNegative(spec)];
  });
}

/** `args ["sales.cjs","bad.csv"]`, `stdin "x"`: how a negative is named on a row. */
export function describeNegative(negative: ContractCheckNegative): string {
  const parts = [
    ...(negative.args === undefined ? [] : [`args ${JSON.stringify(negative.args)}`]),
    ...(negative.stdin === undefined ? [] : [`stdin ${JSON.stringify(negative.stdin.length > 40 ? `${negative.stdin.slice(0, 39)}…` : negative.stdin)}`]),
    ...(negative.env === undefined ? [] : [`env ${Object.keys(negative.env).join(", ")}`]),
  ];
  return parts.join(", ");
}
