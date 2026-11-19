import { lstatSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CRITERION_FACT_STATES,
  milestoneShotsDir,
  normalizeCriterionId,
  PROJECT_LIMITS,
  type CriterionFactState,
  type ProjectCriterion,
  type ProjectCriterionFact,
  type ProjectMilestoneAttachment,
} from "../../session/session-project.js";
import { FusionRunStore, fusionRunShotTarget } from "./run-checkpoint.js";

/**
 * A fan-out's success-criteria facts kept with its run (issue #40):
 * `<stateDir>/fusion-runs/<runId>/criteria.json` (0600), beside the
 * run's screenshots and pruned with them, since the checkpoint goes
 * when the run ends. A milestone report (`project.milestone` done)
 * reads its runs' files and shots ({@link readMilestoneEvidence}).
 *
 * Each fact records the criterion text its checks tested (`text`, issue
 * #87): a fact stands for a criterion only while that text is still the
 * brief's, so an earlier result cannot pass a revised or reused id.
 */

const FILE_NAME = "criteria.json";
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TASKS = 64;
const IMAGE_EXT = /\.(?:jpe?g|png)$/i;
const RANK: Record<CriterionFactState, number> = { passed: 0, unverified: 1, failed: 2 };

export interface RunTaskCriteria {
  taskId: string;
  facts: readonly ProjectCriterionFact[];
}

/** A stored fact: the criterion text its checks tested, when the run knew it. */
type RunFact = ProjectCriterionFact & { text?: string };

/**
 * Write one run's task facts, each with the text of its criterion in
 * `criteria` (the approved brief the run checked against). Best effort:
 * a run that cannot keep them keeps none.
 */
export function writeRunCriteriaFacts(
  runsDir: string,
  run: { runId: string; sessionId: string },
  tasks: readonly RunTaskCriteria[],
  criteria?: ReadonlyMap<string, { text: string }>,
): void {
  const kept = tasks
    .filter((t) => t.facts.length > 0)
    .slice(0, MAX_TASKS)
    .map((t) => ({
      taskId: t.taskId,
      facts: t.facts.map((f): RunFact => {
        const text = criteria?.get(f.id)?.text;
        return text === undefined ? f : { ...f, text };
      }),
    }));
  if (kept.length === 0) return;
  const target = fusionRunShotTarget(runsDir, run, undefined);
  if (target === undefined) return;
  try {
    writeFileSync(join(dirname(target.dir), FILE_NAME), JSON.stringify({ tasks: kept }), { mode: 0o600 });
  } catch {
    // The milestone then has no facts from this run, never wrong ones.
  }
}

interface StoredRun {
  tasks: Array<{ taskId: string; facts: RunFact[] }>;
}

function readRunTasks(runsDir: string, runId: string): StoredRun {
  const none: StoredRun = { tasks: [] };
  if (!FusionRunStore.isValidRunId(runId)) return none;
  let raw: unknown;
  try {
    const path = join(runsDir, runId, FILE_NAME);
    if (statSync(path).size > MAX_FILE_BYTES) return none;
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return none;
  }
  const tasks = (raw as { tasks?: unknown })?.tasks;
  if (!Array.isArray(tasks)) return none;
  const out: StoredRun["tasks"] = [];
  for (const t of tasks.slice(0, MAX_TASKS)) {
    if (typeof t !== "object" || t === null || typeof t.taskId !== "string" || !Array.isArray(t.facts)) continue;
    const facts: RunFact[] = [];
    for (const f of t.facts as unknown[]) {
      if (typeof f !== "object" || f === null) continue;
      const { id, state, why, text } = f as Record<string, unknown>;
      const clean = normalizeCriterionId(id);
      if (clean === null || !CRITERION_FACT_STATES.includes(state as CriterionFactState)) continue;
      facts.push({
        id: clean,
        state: state as CriterionFactState,
        ...(typeof why === "string" ? { why } : {}),
        ...(typeof text === "string" ? { text } : {}),
      });
    }
    out.push({ taskId: t.taskId, facts });
  }
  return { tasks: out };
}

/** A criterion text as its meaning: case and runs of whitespace are editorial (as the brief's own check). */
const meaning = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();

/** Why a fact read for an earlier definition of its criterion stands as unverified. */
export const STALE_FACT_WHY = "checked against an earlier text of this criterion: run its checks again";

export interface MilestoneEvidence {
  /** One per criterion its runs' checks name, in `criteriaOrder`: its newest run's, the worst of that run's tasks. */
  facts: ProjectCriterionFact[];
  /** Each task's screenshots from its newest run that has any, newest first, at most {@link PROJECT_LIMITS}.attachments. */
  attachments: ProjectMilestoneAttachment[];
  /** Criteria of `criteriaOrder` no check of these runs names. */
  uncovered: string[];
}

/**
 * The facts and screenshots of a milestone's runs (oldest first): a
 * criterion's newest run that names it stands for it; within that run
 * it takes the worst state of the tasks naming it (failed, then
 * unverified, then passed).
 */
export function readMilestoneEvidence(input: {
  runsDir: string;
  stateDir: string;
  runIds: readonly string[];
  criteriaOrder: readonly string[];
  /**
   * The approved brief's criteria (issue #87). Given, a fact counts only
   * for the text it recorded; a fact recorded for another text, or for
   * an id the brief no longer has, is stale.
   */
  criteria?: readonly ProjectCriterion[];
  /**
   * How many times the project's brief was approved
   * (`ProjectState.briefApprovals`). A fact with no recorded text (a run
   * file from before the binding, or a resumed run whose checkpoint has
   * no texts) stands only when this is exactly 1: the brief cannot have
   * changed since. Absent or any other count: stale. File times are
   * never read (a copy, restore or sync changes them).
   */
  briefApprovals?: number;
}): MilestoneEvidence {
  const currentText = input.criteria === undefined ? undefined : new Map(input.criteria.map((c) => [c.id, meaning(c.text)]));
  const stale = (fact: RunFact): boolean => {
    if (currentText === undefined) return false;
    if (fact.text !== undefined) return currentText.get(fact.id) !== meaning(fact.text);
    return input.briefApprovals !== 1;
  };
  // A criterion's newest run stands for it, whichever task carried it
  // there (a fix may come under another task id); within one run, the
  // worst of its tasks. Stale facts stand only where no current one
  // does, and then as unverified: never a pass.
  const byTask = new Map<string, readonly ProjectCriterionFact[]>();
  const worst = new Map<string, ProjectCriterionFact>();
  const staleIds = new Set<string>();
  for (const runId of input.runIds) {
    const run = readRunTasks(input.runsDir, runId);
    const inRun = new Map<string, ProjectCriterionFact>();
    for (const task of run.tasks) {
      const valid = task.facts.filter((f) => !stale(f));
      for (const f of task.facts) if (!valid.includes(f)) staleIds.add(f.id);
      byTask.set(task.taskId, valid.map(({ text: _text, ...fact }) => fact));
      for (const { text: _text, ...fact } of valid) {
        const known = inRun.get(fact.id);
        if (known === undefined || RANK[fact.state] > RANK[known.state]) inRun.set(fact.id, fact);
      }
    }
    for (const [id, fact] of inRun) worst.set(id, fact);
  }
  for (const id of staleIds) {
    if (!worst.has(id)) worst.set(id, { id, state: "unverified", why: STALE_FACT_WHY });
  }
  const facts = input.criteriaOrder.flatMap((id) => (worst.has(id) ? [worst.get(id)!] : []));
  const uncovered = input.criteriaOrder.filter((id) => !worst.has(id));
  const shots: Array<{ path: string; mtime: number; taskId: string; n: string; run: number }> = [];
  for (const [run, runId] of input.runIds.entries()) {
    if (!FusionRunStore.isValidRunId(runId)) continue;
    const dir = milestoneShotsDir(input.stateDir, runId);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!IMAGE_EXT.test(name)) continue;
      const path = join(dir, name);
      try {
        // A symlink could point anywhere: only regular files are attached.
        const info = lstatSync(path);
        if (!info.isFile()) continue;
        const match = /^(.*)-(\d+)\.[^.]+$/.exec(name);
        shots.push({ path, mtime: info.mtimeMs, taskId: match?.[1] ?? name, n: match?.[2] ?? "", run });
      } catch {
        // gone
      }
    }
  }
  // A task's pictures come from its newest run that has any: an earlier
  // attempt's shots show a result the milestone no longer stands on, and
  // each run numbers its shots from 1, so they would repeat names.
  const newestRun = new Map<string, number>();
  for (const s of shots) newestRun.set(s.taskId, Math.max(newestRun.get(s.taskId) ?? -1, s.run));
  const current = shots.filter((s) => newestRun.get(s.taskId) === s.run);
  current.sort((a, b) => b.mtime - a.mtime);
  const attachments = current.slice(0, PROJECT_LIMITS.attachments).map((s): ProjectMilestoneAttachment => {
    const criteria = (byTask.get(s.taskId) ?? []).map((f) => f.id).filter((id) => input.criteriaOrder.includes(id));
    return {
      path: s.path,
      caption: `${s.taskId}: screenshot${s.n.length === 0 ? "" : ` ${s.n}`}`,
      ...(criteria.length === 0 ? {} : { criteria }),
    };
  });
  return { facts, attachments, uncovered };
}
