import type { CriterionFactState, ProjectCriterionFact } from "../../session/session-project.js";
import type { ContractCheckOutcome } from "./contract-checks.js";
import type { DelegateContract } from "./contract.js";
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
): ProjectCriterionFact[] {
  return criteria.map((criterion) => {
    let state: CriterionFactState = "passed";
    let why = "every check naming it passed";
    const note = (next: CriterionFactState, line: string): void => {
      if (RANK[next] > RANK[state]) {
        state = next;
        why = line;
      }
    };
    for (const index of criterion.checkIndexes) {
      const outcome = outcomes[index];
      const label = `check ${index + 1}`;
      if (outcome === undefined) {
        note("failed", `${label} did not run`);
        continue;
      }
      if (!outcome.ok) {
        note("failed", `${label} failed: ${outcome.detail}`);
        continue;
      }
      // Issue #110: green on the input it must fail on too, so its green proves nothing.
      if (outcome.unreliable !== undefined) {
        note("unverified", `${label} is unreliable: ${outcome.unreliable}`);
        continue;
      }
      if (contract?.checks?.[index]?.judge !== "vision") continue;
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
      if (judged.state !== "passed") note(judged.state, `vision: ${judged.why}`);
    }
    return { id: criterion.id, state, why };
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
): WorkerTaskResult {
  if (criteria.length === 0) return row;
  const judged = row.judge?.criteria;
  const facts = judged ?? criteriaFactsFor(criteria, contract, outcomes, undefined);
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
