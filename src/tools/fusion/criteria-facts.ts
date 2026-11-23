import { weakestCriterionBasis, type ProjectCriterionBasis, type ProjectCriterionCheckReference } from "../../session/project-criterion-basis.js";
import { receiptHash } from "../../session/receipt-signing.js";
import type { CriterionFactState, ProjectCriterionFact } from "../../session/session-project.js";
import { checkDidNotRun } from "./check-ran.js";
import type { ContractCheckOutcome } from "./contract-checks.js";
import type { DelegateContract } from "./contract.js";
import { checkReservations } from "./contract-check-lint.js";
import type { WorkerTaskResult } from "./worker-result.js";

/**
 * Success criteria as facts (issue #40).
 *
 * A contract check names the brief's criteria it verifies (`criteria`).
 * After a task's work each criterion its checks name gets a fact:
 *
 *  - `failed`: any of its checks failed or did not run, or the vision
 *    judgement of a visual check (`judge: "vision"`) found it not met;
 *  - `unverified`: no check failed, but a visual check has no readable
 *    vision judgement (no vision-capable model, a refusal, an unreadable
 *    answer, a missing screenshot), or a check is unreliable because its
 *    negative control passed too (issue #110): never green without one;
 *  - `passed`: every check green and every visual check judged met.
 *
 * `failed` outranks `unverified`, which outranks `passed`: vision can
 * only add red or unverified, never turn a red check green.
 *
 * A `passed` criterion supported only by checks with verification or
 * lint warnings, or unavailable negative controls, carries a `reservation` — "verified with reservations". No verdict
 * reads it: it stays `passed`, and one clean passing check clears it.
 */

/** One criterion a task's checks name, with the check indices (into `contract.checks`) naming it. */
export interface TaskCriterion {
  id: string;
  /** The brief's text; empty for an id the brief does not have. */
  text: string;
  checkIndexes: number[];
}

/** A vision judgement of one criterion (`vision-judge.ts`). */
export interface VisionCriterionVerdict {
  state: CriterionFactState;
  why: string;
  /** Model reference only when the model gave a verdict. */
  model?: string;
}

/** Criterion id → its vision judgement, for one task. */
export type VisionJudgements = ReadonlyMap<string, VisionCriterionVerdict>;

/** The criteria `taskId`'s checks name, in first-mention order. */
export function taskCriteria(
  taskId: string,
  contract: DelegateContract | undefined,
  criteria: ReadonlyMap<string, { id: string; text: string }>,
): TaskCriterion[] {
  const out: TaskCriterion[] = [];
  (contract?.checks ?? []).forEach((check, index) => {
    if (check.task !== taskId) return;
    for (const id of check.criteria ?? []) {
      const known = out.find((c) => c.id === id);
      if (known !== undefined) known.checkIndexes.push(index);
      else out.push({ id, text: criteria.get(id)?.text ?? "", checkIndexes: [index] });
    }
  });
  return out;
}

/** `[c1] "text"`: how a criterion is named in every fact line. */
export function criterionLabel(criterion: Pick<TaskCriterion, "id" | "text">): string {
  return criterion.text.length === 0 ? `[${criterion.id}]` : `[${criterion.id}] ${JSON.stringify(criterion.text)}`;
}

const RANK: Record<CriterionFactState, number> = { passed: 0, unverified: 1, failed: 2 };

/** One fact per criterion, in the order given. */
export function criteriaFactsFor(
  criteria: readonly TaskCriterion[],
  contract: DelegateContract | undefined,
  outcomes: readonly (ContractCheckOutcome | undefined)[],
  vision: VisionJudgements | undefined,
  runId?: string,
): ProjectCriterionFact[] {
  const reservations = checkReservations(contract);
  const reservationOf = (index: number, outcome: ContractCheckOutcome): string | undefined => {
    const reasons: string[] = [];
    const { warningCount = 0, impeccableExceptions = [], negative } = outcome;
    if (warningCount > 0) {
      reasons.push(`${warningCount} warning${warningCount === 1 ? "" : "s"}`);
      for (const exception of impeccableExceptions) {
        const line = exception.replace(/\s+/g, " ").trim();
        const approved = /^([a-z0-9-]+)(?::.*?)? — approved by the operator: (.+)$/u.exec(line);
        if (approved === null) {
          reasons.push(line.slice(0, 180));
          continue;
        }
        const reason = approved[2]!;
        reasons.push(`${approved[1]} (approved by the operator: ${reason.length > 100 ? `${reason.slice(0, 100)}…` : reason})`);
      }
    }
    if (negative !== undefined) reasons.push(`its negative control did not run (${negative})`);
    else if (contract?.checks?.[index]?.negative === undefined) {
      // A successful negative control resolves lint warnings about check strength.
      const lint = reservations.get(index);
      if (lint !== undefined) reasons.push(lint);
    }
    return reasons.length === 0 ? undefined : reasons.join("; ");
  };
  return criteria.map((criterion) => {
    let state: CriterionFactState = "passed";
    let why = "every check naming it passed";
    // Issue #110: whether a passing check with nothing held against it
    // supports it, and what is held against the others.
    let clean = false;
    const held = new Map<number, string>();
    const settle = (index: number, outcome: ContractCheckOutcome): void => {
      const reason = reservationOf(index, outcome);
      if (reason === undefined) clean = true;
      else held.set(index, reason);
    };
    let decisiveBasis: ProjectCriterionBasis | undefined;
    const note = (next: CriterionFactState, line: string, source?: ProjectCriterionBasis): void => {
      if (RANK[next] > RANK[state]) {
        state = next;
        why = line;
        decisiveBasis = source;
      }
    };
    let basis: ProjectCriterionBasis | undefined;
    const addBasis = (source: ProjectCriterionBasis): void => {
      basis = basis === undefined ? source : weakestCriterionBasis(basis, source);
    };
    for (const index of criterion.checkIndexes) {
      const outcome = outcomes[index];
      const label = `check ${index + 1}`;
      if (outcome === undefined) {
        note("failed", `${label} did not run`);
        continue;
      }
      if (outcome.artifactStatus === "uncheckable") {
        note("unverified", `${label} uncheckable: ${outcome.detail}`);
        continue;
      }
      const spec = contract?.checks?.[index];
      const outputHash = outcome.run === undefined ? outcome.outputHash : receiptHash(outcome.run.output);
      const reference: ProjectCriterionCheckReference = {
        index: index + 1,
        ...(runId === undefined ? {} : { runId }),
        ...(outputHash === undefined ? {} : { outputHash }),
      };
      if (spec !== undefined && (spec.kind ?? spec.type) === "ui") {
        reference.kind = "ui";
        reference.mode = spec.path === undefined ? "rendered" : "file";
        if (outcome.impeccableVersion !== undefined) reference.impeccableVersion = outcome.impeccableVersion;
      }
      const measured: ProjectCriterionBasis | undefined = outcome.ok || !checkDidNotRun(outcome.detail)
        ? { kind: "check", checks: [reference] }
        : undefined;
      if (!outcome.ok) {
        note("failed", `${label} failed: ${outcome.detail}`, measured);
        continue;
      }
      // Issue #110: green on the input it must fail on too, so its green proves nothing.
      if (outcome.unreliable !== undefined) {
        note("unverified", `${label} is unreliable: ${outcome.unreliable}`);
        continue;
      }
      if (measured !== undefined) addBasis(measured);
      if (contract?.checks?.[index]?.judge !== "vision") {
        settle(index, outcome);
        continue;
      }
      if (outcome.screenshotErrors !== undefined && outcome.screenshotErrors.length > 0) {
        note("unverified", `${label} took no screenshot: ${outcome.screenshotErrors[0]}`);
        continue;
      }
      if (outcome.screenshots === undefined || outcome.screenshots.length === 0) {
        note("unverified", `${label} took no screenshot`);
        continue;
      }
      const judged = vision?.get(criterion.id);
      if (judged === undefined) {
        note("unverified", `${label} is visual and has no vision judgement`);
        continue;
      }
      const visual: ProjectCriterionBasis | undefined = judged.model === undefined ? undefined : { kind: "vision", model: judged.model };
      if (judged.state !== "passed") note(judged.state, `vision: ${judged.why}`, visual);
      else {
        if (visual !== undefined) addBasis(visual);
        settle(index, outcome);
      }
    }
    const source = (state as CriterionFactState) === "passed" ? basis : decisiveBasis;
    const fact = { id: criterion.id, state, why, ...(source === undefined ? {} : { basis: source }) };
    if (state !== "passed" || clean) return fact;
    const reservation = [...new Set([...held].map(([i, reason]) => `check ${i + 1}: ${reason}`))].join("; ");
    return reservation.length === 0 ? fact : { ...fact, reservation };
  });
}

/** The director's choices for a criterion that did not close. */
export const CRITERIA_DIRECTOR_GUIDANCE =
  "The director decides: fix it and re-delegate, add a vision-capable reviewer, accept it with reasons, or ask the person";

/**
 * Every task whose checks name criteria gets its facts, whether or not a
 * judge ran (`criteria`): the judge's when it ruled, else the checks'
 * own, with no vision judgement (a visual criterion is then
 * `unverified`). A task the judge did not rule on stays open on any
 * criterion that is not `passed`: never green without its criteria.
 */
export function holdOnCriteria(
  row: WorkerTaskResult,
  criteria: readonly TaskCriterion[],
  contract: DelegateContract | undefined,
  outcomes: readonly (ContractCheckOutcome | undefined)[],
  runId?: string,
): WorkerTaskResult {
  if (criteria.length === 0) return row;
  const judged = row.judge?.criteria;
  const facts = judged ?? criteriaFactsFor(criteria, contract, outcomes, undefined, runId);
  const out: WorkerTaskResult = { ...row, criteria: facts };
  if (judged !== undefined || row.status !== "ok") return out;
  const open = facts.filter((fact) => fact.state !== "passed");
  if (open.length === 0) return out;
  const lines = open.map((fact) => {
    const criterion = criteria.find((c) => c.id === fact.id)!;
    return `${criterionLabel(criterion)} ${fact.state} — ${fact.why ?? fact.state}`;
  });
  return {
    ...out,
    status: "needs_orchestrator",
    notes: [
      ...(row.notes ?? []),
      `criteria: ${open.length} success criteri${open.length === 1 ? "on" : "a"} not closed: ${lines.join("; ")}. ${CRITERIA_DIRECTOR_GUIDANCE}; the task stays open`,
    ],
  };
}
