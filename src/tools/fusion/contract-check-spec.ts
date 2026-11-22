import { normalizeCriterionId } from "../../session/project-criterion-id.js";
import { PROJECT_LIMITS } from "../../session/project-limits.js";
import type { ContractCheck } from "./contract.js";
import { parseCheckNegative } from "./contract-check-negative.js";

export const MAX_CONTRACT_CHECKS = PROJECT_LIMITS.checks;
const MAX_CHECK_CRITERIA = PROJECT_LIMITS.successCriteria;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Parse the shared contract-check language without linting or executing a spec. */
export function parseContractChecks(raw: unknown, known: (task: unknown, label: string) => string | null, problems: string[]): ContractCheck[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    problems.push("contract.checks must be an array of verify.run specs");
  } else if (raw.length > MAX_CONTRACT_CHECKS) {
    problems.push(
      `contract.checks has ${raw.length} entries; at most ${MAX_CONTRACT_CHECKS}`,
    );
  } else {
    const checks: ContractCheck[] = [];
    for (let i = 0; i < raw.length; i += 1) {
      const entry: unknown = raw[i];
      const label = `contract.checks[${i}]`;
      if (!isRecord(entry)) {
        problems.push(`${label} must be an object`);
        continue;
      }
      const { task, criteria: rawCriteria, judge, negative: rawNegative, ...spec } = entry;
      if (Object.keys(spec).length === 0) {
        problems.push(`${label} carries no verify.run arguments`);
        continue;
      }
      const criteria = readCheckCriteria(rawCriteria, `${label}.criteria`, problems);
      if (criteria === null) continue;
      if (!readCheckJudge(judge, spec, criteria, `${label}.judge`, problems)) continue;
      // Issue #110: the same command on an input that must fail.
      if ((spec.kind ?? spec.type) === "ui" && typeof spec.service === "string" && rawNegative != null) {
        problems.push(`${label}: service-backed UI checks cannot have a negative control`);
        continue;
      }
      const negative = parseCheckNegative(rawNegative, spec, label, problems);
      if (negative === null) continue;
      const controlled = negative === undefined ? spec : { ...spec, negative };
      const judged = judge === undefined || judge === null ? controlled : { judge: "vision" as const, ...controlled };
      const withCriteria = criteria.length === 0 ? judged : { criteria, ...judged };
      if (task === undefined || task === null) {
        // Criteria close with a task (`criteria-facts.ts`): a call-level
        // check names no task they could hold open.
        if (criteria.length > 0) {
          problems.push(`${label}.criteria needs the \`task\` whose check it is: a criterion is a fact of the task that closes on it`);
          continue;
        }
        checks.push(withCriteria);
        continue;
      }
      const bad = known(task, `${label}.task`);
      if (bad !== null) {
        problems.push(bad);
        continue;
      }
      checks.push({ task: (task as string).trim(), ...withCriteria });
    }
    const services = new Map<string, ContractCheck>();
    for (const check of checks) {
      const kind = check.kind ?? check.type;
      if (kind === "service" && typeof check.id === "string") {
        if (services.has(check.id)) problems.push(`duplicate contract check service: ${check.id}`);
        services.set(check.id, check);
      } else if (kind === "ui" && typeof check.service === "string") {
        const service = services.get(check.service);
        if (service === undefined || service.task !== check.task) {
          problems.push(`UI check service ${check.service} must name an earlier service check on the same task or at the same call level`);
        }
      }
    }
    return checks;
  }
  return [];
}

/** Row ownership is implicit; explicit ownership must name this same task. */
export function parsePlanRowChecks(raw: unknown, taskId: string, problems: string[]): ContractCheck[] {
  const entries = Array.isArray(raw) ? raw.map((c: unknown) => isRecord(c) ? { ...c, task: c.task ?? taskId } : c) : raw;
  return parseContractChecks(entries, (task, label) => typeof task === "string" && task.trim() === taskId ? null : `${label} must name this plan task (${taskId})`, problems)
    .map(({ task: _task, ...spec }) => spec);
}

function readCheckJudge(
  raw: unknown,
  spec: Record<string, unknown>,
  criteria: readonly string[],
  label: string,
  problems: string[],
): boolean {
  if (raw === undefined || raw === null) return true;
  if (raw !== "vision") {
    problems.push(`${label} must be "vision"`);
    return false;
  }
  const kind = spec.kind ?? spec.type;
  if (kind !== "page" || spec.screenshot === undefined || spec.screenshot === null) {
    problems.push(`${label} needs a page check with a \`screenshot\``);
    return false;
  }
  if (criteria.length === 0) {
    problems.push(`${label} needs the \`criteria\` it judges`);
    return false;
  }
  return true;
}

/**
 * A check's `criteria` (issue #40): the success-criterion ids it
 * verifies, trimmed, unique, at most 20. `null` (with the problem
 * recorded) when malformed; `[]` when absent or empty.
 */
function readCheckCriteria(raw: unknown, label: string, problems: string[]): string[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    problems.push(`${label} must be an array of criterion ids`);
    return null;
  }
  if (raw.length > MAX_CHECK_CRITERIA) {
    problems.push(`${label} has ${raw.length} entries; at most ${MAX_CHECK_CRITERIA}`);
    return null;
  }
  const ids: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    // The brief's rule (trimmed, lower-cased), so a check's ids match the brief's.
    const id = normalizeCriterionId(raw[i]);
    if (id === null) {
      problems.push(`${label}[${i}] ${JSON.stringify(raw[i])} is not a criterion id (a-z, 0-9 and -; at most 32)`);
      return null;
    }
    if (ids.includes(id)) {
      problems.push(`${label} repeats ${JSON.stringify(id)}`);
      return null;
    }
    ids.push(id);
  }
  return ids;
}
