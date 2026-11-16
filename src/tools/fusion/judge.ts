import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { completionCostUsd } from "../../llm/provider/usage-cost.js";
import type { DelegateTask } from "./delegate-args.js";
import { describeProvide, type DelegateContract } from "./contract.js";
import type {
  ContractCheckOutcome,
  ContractFinding,
} from "./contract-checks.js";
import { CHECK_OUTPUT_CHARS, tailClip } from "./contract-checks.js";
import type { EscalationComplete } from "./escalation.js";
import type { WorkerPricing, WorkerTaskResult } from "./worker-result.js";
import type { WorkspaceChange } from "./branch-diff.js";
import { outcomeLabel } from "./outcome-log.js";
import {
  knownSecretsFromEnv,
  maskSecrets,
  type KnownSecret,
} from "../../error-reporting/secret-detector.js";

/**
 * The trimmed judge (ATO-944): a node is closed by its acceptance list,
 * not by its worker saying "done".
 *
 * Every benchmark run so far reported "verified" over wrong scenes: the
 * contract's checks catch a crash, not wrong behaviour, and the worker's
 * own reply is the least reliable witness there is. So, with
 * `llm.runMode.fusion.judge: "on"`:
 *
 *  1. **Before the work** each task gets an acceptance checklist built
 *     from the contract — its `checks`, its `provides`, its declared
 *     files — plus its deliverable and instructions. The worker reads it
 *     in its brief and cannot change it.
 *  2. **After the work** the list is checked. Facts first: a check that
 *     failed or did not run, a provide that is missing, a declared file
 *     that is absent or empty are red, whatever any model says. Then a
 *     judge in a fresh context — no worker transcript, no worker claims
 *     about files — reads the work itself and rules on the items no
 *     script can (the deliverable, a provide's shape, the instructions).
 *     Under isolation the work is the task's unified diff against the
 *     snapshot its workspace started from, every touched file listed
 *     (declared or not), a new file shown as its head; elsewhere there
 *     is no snapshot of the folder before the wave, so it is the head
 *     of each declared file. Evidence is masked before it is sent.
 *     The judge can only add red: it never turns a failed fact green.
 *     An item it gives no verdict for is red. An answer that cannot be
 *     read leaves the node unverified, never green.
 *  3. A red list re-runs the task once with the judge's findings; a list
 *     still red after that is reported as failed, item by item.
 *
 * The judge answers a strict review schema (issue #38, {@link
 * parseJudgeAnswer}): a decision and a list of issues, each with a
 * severity. Every verdict also carries that review ({@link
 * ReviewVerdict}): red facts are blocker issues `by: "fact"`; an accept
 * with a blocker or major issue, or with a red fact, is needs-changes; a
 * minor-only review is an accept that lists its minors; an answer
 * outside the schema is unverified, never repaired.
 */

/** How much an issue a review found weighs (issue #38). */
export type ReviewSeverity = "blocker" | "major" | "minor";

/** One issue of a review: from a red fact, or from the reviewer model. */
export interface ReviewIssue {
  /** The acceptance item it concerns (`a3`); null for the work as a whole. */
  item: string | null;
  severity: ReviewSeverity;
  /** The file it is in, when one; null otherwise. */
  file: string | null;
  why: string;
  by: "fact" | "reviewer";
}

export type ReviewDecision = "accept" | "needs-changes" | "unverified";

/** A task's review: the decision, every issue, and who reviewed. */
export interface ReviewVerdict {
  decision: ReviewDecision;
  issues: ReviewIssue[];
  /** `outcomeLabel` of the reviewer model that was asked; null when no model was. */
  reviewer: string | null;
}

/** Schema bounds of a reviewer's answer. */
export const REVIEW_MAX_ISSUES = 20;
export const REVIEW_WHY_CHARS = 200;
/** An issue's `item` and `file`, when given, are at most this long too. */
export const REVIEW_REF_CHARS = 200;
export const REVIEW_SEVERITIES: readonly ReviewSeverity[] = ["blocker", "major", "minor"];

export type AcceptanceItemKind =
  | "check"
  | "provide"
  | "file"
  | "deliverable"
  | "instructions";

export interface AcceptanceItem {
  id: string;
  kind: AcceptanceItemKind;
  text: string;
  /** `check`: index into `contract.checks`, i.e. into the check outcomes. */
  checkIndex?: number;
  /** `provide`: the provide's name, to find its presence finding. */
  provideName?: string;
  /** `provide` with a shape: the judge also rules on the meaning. */
  judged: boolean;
  /** `file`: the declared path. */
  path?: string;
}

const INSTRUCTIONS_ITEM_CHARS = 300;
/** How much of each file, and of all files, the judge reads. */
export const JUDGE_FILE_CHARS = 6_000;
export const JUDGE_EVIDENCE_CHARS = 24_000;
/** How much of one file's diff the judge reads. */
export const JUDGE_DIFF_FILE_CHARS = 12_000;
/** Touched paths listed by name; the rest are counted. */
export const JUDGE_TOUCHED_PATHS = 40;
/** Room for the decision and up to {@link REVIEW_MAX_ISSUES} short issues. */
export const JUDGE_MAX_OUTPUT_TOKENS = 2_000;

export function buildAcceptanceChecklist(
  task: DelegateTask,
  contract: DelegateContract | undefined,
): AcceptanceItem[] {
  const items: AcceptanceItem[] = [];
  const next = (): string => `a${items.length + 1}`;
  (contract?.checks ?? []).forEach((check, index) => {
    if (check.task !== task.id) return;
    const { task: _task, ...spec } = check;
    items.push({
      id: next(),
      kind: "check",
      text: `the check passes: ${JSON.stringify(spec).slice(0, 200)}`,
      checkIndex: index,
      judged: false,
    });
  });
  for (const provide of contract?.provides ?? []) {
    if (provide.task !== task.id) continue;
    items.push({
      id: next(),
      kind: "provide",
      text: `provides ${describeProvide(provide)}`,
      provideName: provide.name,
      judged: provide.shape !== undefined,
    });
  }
  for (const path of task.files ?? []) {
    items.push({
      id: next(),
      kind: "file",
      text: `${path} exists and is not empty`,
      path,
      judged: false,
    });
  }
  if (task.deliverable !== undefined && task.deliverable.trim().length > 0) {
    items.push({
      id: next(),
      kind: "deliverable",
      text: `the deliverable is met: ${task.deliverable.trim()}`,
      judged: true,
    });
  }
  const instructions = task.instructions.replace(/\s+/g, " ").trim();
  items.push({
    id: next(),
    kind: "instructions",
    text: `the task is done as instructed: ${instructions.length > INSTRUCTIONS_ITEM_CHARS ? `${instructions.slice(0, INSTRUCTIONS_ITEM_CHARS)}…` : instructions}`,
    judged: true,
  });
  return items;
}

/** What the worker reads in its brief: the list, read-only. */
export function renderAcceptanceBlock(items: readonly AcceptanceItem[]): string {
  return [
    "ACCEPTANCE CHECKLIST (read-only). After you finish, a separate judge with no access to this conversation checks every item against the files and check results — not against your reply. Your task does not close until every item is green:",
    ...items.map((item) => `- [${item.id}] ${item.text}`),
  ].join("\n");
}

export interface ItemVerdict {
  id: string;
  pass: boolean;
  why: string;
  /**
   * Who decided: a fact (check, presence, file), the judge, or nobody —
   * `skipped` when a fact was already red and the judge was not asked
   * (the list cannot be green either way; asking would only cost).
   */
  by: "fact" | "judge" | "skipped";
  /**
   * A failed check's output tail (`ContractCheckOutcome.output`), for
   * the retried worker's brief: the assertion, not just "exit 1".
   */
  output?: string;
}

export interface JudgeVerdict {
  /** Every item green. */
  green: boolean;
  items: ItemVerdict[];
  /** Why no verdict could be reached, when none was; never green then. */
  unverified?: string;
  costUsd: number | null;
  /** The structured review (issue #38); `green` is `review.decision === "accept"`. */
  review: ReviewVerdict;
}

export interface JudgeFacts {
  /** Outcomes in `contract.checks` order (`runContractChecks`). */
  checkOutcomes: readonly (ContractCheckOutcome | undefined)[];
  findings: readonly ContractFinding[];
}

/** The facts' verdicts; `undefined` for an item only the judge can rule on. */
async function factVerdict(
  item: AcceptanceItem,
  facts: JudgeFacts,
  workingDir: string,
): Promise<ItemVerdict | undefined> {
  if (item.kind === "check") {
    const outcome = facts.checkOutcomes[item.checkIndex ?? -1];
    if (outcome === undefined) {
      return { id: item.id, pass: false, why: "the check did not run", by: "fact" };
    }
    return {
      id: item.id,
      pass: outcome.ok,
      why: outcome.detail,
      by: "fact",
      ...(outcome.ok || outcome.output === undefined ? {} : { output: outcome.output }),
    };
  }
  if (item.kind === "provide") {
    const finding = facts.findings.find((f) => f.name === item.provideName);
    if (finding !== undefined && !finding.present) {
      return {
        id: item.id,
        pass: false,
        why: finding.detail ?? `not found in ${finding.where.join(", ")}`,
        by: "fact",
      };
    }
    return item.judged
      ? undefined
      : {
          id: item.id,
          pass: finding !== undefined,
          why: finding === undefined ? "its presence could not be checked" : "present",
          by: "fact",
        };
  }
  if (item.kind === "file") {
    try {
      const info = await stat(absolute(item.path ?? "", workingDir));
      return info.isFile() && info.size > 0
        ? { id: item.id, pass: true, why: `${info.size} bytes`, by: "fact" }
        : { id: item.id, pass: false, why: "empty or not a file", by: "fact" };
    } catch {
      return { id: item.id, pass: false, why: "missing", by: "fact" };
    }
  }
  return undefined;
}

function absolute(path: string, workingDir: string): string {
  return isAbsolute(path) ? path : resolve(workingDir, path);
}

function clipped(body: string, cap: number, what: string): string {
  return body.length > cap
    ? `${body.slice(0, cap)}\n[… ${body.length - cap} more chars ${what}clipped]`
    : body;
}

function normalised(path: string): string {
  return path.trim().replace(/^(?:\.\/)+/, "");
}

/**
 * The task's changes as the judge reads them: the touched files listed,
 * each diff (a new file as its head), then the declared files it left
 * as they were, as heads, within what is left of the budget.
 */
async function diffEvidence(
  declared: readonly string[],
  changes: readonly WorkspaceChange[],
  workingDir: string,
  known: readonly KnownSecret[],
): Promise<string> {
  const listed = changes
    .slice(0, JUDGE_TOUCHED_PATHS)
    .map((c) => `${c.path} (${c.kind})`);
  const more = changes.length - listed.length;
  const touched = new Set(changes.map((c) => c.path));
  const untouched = declared.filter(
    (p) =>
      !touched.has(normalised(p)) &&
      ![...touched].some((t) => isAbsolute(p) && p.endsWith(`/${t}`)),
  );
  const parts: string[] = [
    "The task's changes, as a unified diff against the files as they were before it ran: lines not shown are unchanged; a new file is shown as its content.",
    `Touched files: ${listed.join(", ")}${more > 0 ? `, and ${more} more` : ""}`,
  ];
  if (untouched.length > 0) {
    parts.push(`Declared but not changed: ${untouched.join(", ")}`);
  }
  let budget = JUDGE_EVIDENCE_CHARS;
  for (const change of changes) {
    if (budget <= 0) {
      parts.push(`### ${change.path} (${change.kind})\n[not shown: evidence budget spent]`);
      continue;
    }
    // Masked whole, then clipped: a secret the cap cuts in half would
    // no longer match the detector. Only this copy is masked; the
    // saved patch in the person's folder stays as written (appliable).
    const shown =
      change.kind === "added" && change.content !== undefined
        ? clipped(maskSecrets(change.content, known), Math.min(JUDGE_FILE_CHARS, budget), "")
        : clipped(maskSecrets(change.patch, known), Math.min(JUDGE_DIFF_FILE_CHARS, budget), "of diff ");
    budget -= shown.length;
    parts.push(
      `### ${change.path} (${change.kind === "added" ? "new file" : change.kind === "modified" ? "diff" : change.kind})\n${shown}`,
    );
  }
  for (const path of untouched) {
    if (budget <= 0) {
      parts.push(`### ${path} (unchanged)\n[not shown: evidence budget spent]`);
      continue;
    }
    let body: string;
    try {
      body = await readFile(absolute(path, workingDir), "utf8");
    } catch {
      parts.push(`### ${path}\n[missing]`);
      continue;
    }
    const shown = clipped(maskSecrets(body, known), Math.min(JUDGE_FILE_CHARS, budget), "");
    budget -= shown.length;
    parts.push(`### ${path} (unchanged)\n${shown}`);
  }
  return parts.join("\n\n");
}

/**
 * What the judge reads, masked: the task's diff when its changes are
 * known (isolation), else the declared files' heads; the worker's reply
 * only when it declared and changed nothing.
 */
export async function gatherEvidence(
  task: DelegateTask,
  contract: DelegateContract | undefined,
  reply: string,
  workingDir: string,
  changes?: readonly WorkspaceChange[],
  knownSecrets?: readonly KnownSecret[],
): Promise<string> {
  const known = knownSecrets ?? knownSecretsFromEnv();
  // Each part is masked before it is clipped (a secret cut at a cap
  // escapes the detector); the whole is masked again for what spans
  // parts.
  return maskSecrets(
    await rawEvidence(task, contract, reply, workingDir, changes, known),
    known,
  );
}

async function rawEvidence(
  task: DelegateTask,
  contract: DelegateContract | undefined,
  reply: string,
  workingDir: string,
  changes: readonly WorkspaceChange[] | undefined,
  known: readonly KnownSecret[],
): Promise<string> {
  const paths = [
    ...(task.files ?? []),
    ...(contract?.provides ?? [])
      .filter((p) => p.task === task.id && p.in !== undefined)
      .map((p) => p.in!),
  ].filter((p, i, all) => all.indexOf(p) === i);
  if (changes !== undefined && changes.length > 0) {
    return diffEvidence(paths, changes, workingDir, known);
  }
  if (paths.length === 0) {
    return [
      "This task declared no files, so its reply is the deliverable. Judge what the reply contains, not what it says it did elsewhere.",
      "### reply",
      clipped(maskSecrets(reply, known), JUDGE_EVIDENCE_CHARS, ""),
    ].join("\n");
  }
  const parts: string[] = [];
  let budget = JUDGE_EVIDENCE_CHARS;
  for (const path of paths) {
    if (budget <= 0) {
      parts.push(`### ${path}\n[not shown: evidence budget spent]`);
      continue;
    }
    let body: string;
    try {
      body = await readFile(absolute(path, workingDir), "utf8");
    } catch {
      parts.push(`### ${path}\n[missing]`);
      continue;
    }
    const shown = clipped(maskSecrets(body, known), Math.min(JUDGE_FILE_CHARS, budget), "");
    budget -= shown.length;
    parts.push(`### ${path}\n${shown}`);
  }
  return parts.join("\n\n");
}

export function renderJudgePrompt(input: {
  task: DelegateTask;
  items: readonly AcceptanceItem[];
  facts: readonly ItemVerdict[];
  evidence: string;
}): string {
  const judged = input.items.filter(
    (item) => !input.facts.some((fact) => fact.id === item.id),
  );
  return [
    "You are a strict acceptance judge. A worker says it finished the task below. Do not trust it: find where the work does NOT meet each item. Rule only from the evidence shown. If the evidence does not show an item is met, it is not met.",
    "",
    "## Task",
    input.task.instructions.slice(0, 4_000),
    "",
    "## Items to rule on",
    ...judged.map((item) => `- ${item.id}: ${item.text}`),
    "",
    "## Already established by scripts (for context; not yours to change)",
    ...(input.facts.length === 0
      ? ["(none)"]
      : input.facts.map((f) => `- ${f.id}: ${f.pass ? "met" : "NOT met"} — ${f.why}`)),
    "",
    "## Evidence",
    input.evidence,
    "",
    'Answer with JSON only, exactly this shape and no other keys: {"decision":"accept"|"needs-changes","issues":[{"item":"a2"|null,"severity":"blocker"|"major"|"minor","file":"src/a.ts"|null,"why":"…"}]}',
    `- decision: "accept" when every item to rule on is met; "needs-changes" names at least one issue.`,
    `- issues: what is wrong, at most ${REVIEW_MAX_ISSUES} issues. item: the item id it breaks, or null for the work as a whole. file: the file it is in, or null. item and file at most ${REVIEW_REF_CHARS} characters each.`,
    `- severity: "blocker" (an item is not met), "major" (met only in part, or wrong behaviour), "minor" (style or a nit; does not block acceptance).`,
    `- why: one line, at most ${REVIEW_WHY_CHARS} characters, naming what is wrong.`,
    "- List an issue for every item that is not met (a blocker naming its id), even when you also list others. An item no issue names counts as met.",
  ].join("\n");
}

/** A reviewer's answer read against the schema; `ok: false` with the first reason it is not. */
export type ParsedReviewAnswer =
  | {
      ok: true;
      decision: "accept" | "needs-changes";
      issues: Array<Omit<ReviewIssue, "by">>;
    }
  | { ok: false; error: string };

const ANSWER_KEYS = ["decision", "issues"];
const ISSUE_KEYS = ["item", "severity", "file", "why"];

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(value, k));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The reviewer's answer, strictly (issue #38): the JSON object in the
 * content (prose around it is ignored), with exactly `decision` and
 * `issues`, each issue with exactly `item`, `severity`, `file` and
 * `why`. Nothing is repaired: a missing, extra or mistyped field, more
 * than {@link REVIEW_MAX_ISSUES} issues, a blank `why` or one over
 * {@link REVIEW_WHY_CHARS} chars, an `item` or `file` over
 * {@link REVIEW_REF_CHARS} chars, or a needs-changes with no issue,
 * refuses the whole answer.
 */
export function parseJudgeAnswer(content: string): ParsedReviewAnswer {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) return { ok: false, error: "no JSON object" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return { ok: false, error: "not valid JSON" };
  }
  if (!isRecord(parsed) || !exactKeys(parsed, ANSWER_KEYS)) {
    return { ok: false, error: "expected exactly decision and issues" };
  }
  const { decision, issues } = parsed;
  if (decision !== "accept" && decision !== "needs-changes") {
    return { ok: false, error: "decision is not accept or needs-changes" };
  }
  if (!Array.isArray(issues)) return { ok: false, error: "issues is not a list" };
  if (issues.length > REVIEW_MAX_ISSUES) {
    return { ok: false, error: `more than ${REVIEW_MAX_ISSUES} issues` };
  }
  const out: Array<Omit<ReviewIssue, "by">> = [];
  for (const [i, entry] of issues.entries()) {
    if (!isRecord(entry) || !exactKeys(entry, ISSUE_KEYS)) {
      return { ok: false, error: `issue ${i + 1}: expected exactly item, severity, file and why` };
    }
    const { item, severity, file, why } = entry;
    if (item !== null && (typeof item !== "string" || item.length > REVIEW_REF_CHARS)) {
      return { ok: false, error: `issue ${i + 1}: item` };
    }
    if (!REVIEW_SEVERITIES.includes(severity as ReviewSeverity)) {
      return { ok: false, error: `issue ${i + 1}: severity` };
    }
    if (file !== null && (typeof file !== "string" || file.length > REVIEW_REF_CHARS)) {
      return { ok: false, error: `issue ${i + 1}: file` };
    }
    if (typeof why !== "string" || why.trim().length === 0 || why.length > REVIEW_WHY_CHARS) {
      return { ok: false, error: `issue ${i + 1}: why` };
    }
    out.push({ item, severity: severity as ReviewSeverity, file, why });
  }
  if (decision === "needs-changes" && out.length === 0) {
    return { ok: false, error: "needs-changes without an issue" };
  }
  return { ok: true, decision, issues: out };
}

/** A blocker or major issue: one that keeps a task from closing. */
export function blocksAcceptance(issue: Pick<ReviewIssue, "severity">): boolean {
  return issue.severity !== "minor";
}

/** Red facts as blocker issues; a skipped item is not one. */
function factIssues(
  items: readonly AcceptanceItem[],
  facts: readonly ItemVerdict[],
): ReviewIssue[] {
  return facts
    .filter((v) => !v.pass && v.by === "fact")
    .map((v) => ({
      item: v.id,
      severity: "blocker" as const,
      file: items.find((i) => i.id === v.id)?.path ?? null,
      why: v.why,
      by: "fact" as const,
    }));
}

export interface JudgeTarget {
  providerId: string;
  model: string | null;
  /** The model the completion asks for (a fusion team reviewer's, issue #37); absent, the provider's own. */
  pinModel?: string;
}

/**
 * Rule on one task's list. Never throws; a judge that cannot run or
 * answer leaves the task unverified, which is not green.
 */
export async function judgeTask(input: {
  task: DelegateTask;
  items: readonly AcceptanceItem[];
  facts: JudgeFacts;
  reply: string;
  contract: DelegateContract | undefined;
  workingDir: string;
  /** What the task changed (isolation): the judge reads the diff. */
  changes?: readonly WorkspaceChange[];
  /** The agent's own keys, for masking the evidence. */
  knownSecrets?: readonly KnownSecret[];
  target: JudgeTarget;
  pricing: WorkerPricing | undefined;
  complete: EscalationComplete;
  signal: AbortSignal;
}): Promise<JudgeVerdict> {
  const reviewer = outcomeLabel(input.target.pinModel ?? input.target.model ?? input.target.providerId);
  const factVerdicts: ItemVerdict[] = [];
  for (const item of input.items) {
    const verdict = await factVerdict(item, input.facts, input.workingDir);
    if (verdict !== undefined) factVerdicts.push(verdict);
  }
  const needsJudge = input.items.filter(
    (item) => !factVerdicts.some((fact) => fact.id === item.id),
  );
  // A red fact makes the list red whatever the judge would say, so the
  // judge is not paid to say it; its items are listed as not judged.
  if (needsJudge.length === 0 || factVerdicts.some((v) => !v.pass)) {
    const skipped = needsJudge.map(
      (item): ItemVerdict => ({
        id: item.id,
        pass: false,
        why: "not judged: a scripted item is already red",
        by: "skipped",
      }),
    );
    const green = factVerdicts.every((v) => v.pass) && skipped.length === 0;
    return {
      green,
      items: [...factVerdicts, ...skipped].sort(
        (a, b) => itemOrder(a.id) - itemOrder(b.id),
      ),
      costUsd: null,
      review: {
        decision: green ? "accept" : "needs-changes",
        issues: factIssues(input.items, factVerdicts),
        reviewer: null,
      },
    };
  }
  const evidence = await gatherEvidence(
    input.task,
    input.contract,
    input.reply,
    input.workingDir,
    input.changes,
    input.knownSecrets,
  );
  let content: string;
  let costUsd: number | null = null;
  try {
    const answer = await input.complete({
      providerId: input.target.providerId,
      ...(input.target.pinModel === undefined ? {} : { model: input.target.pinModel }),
      prompt: renderJudgePrompt({
        task: input.task,
        items: input.items,
        facts: factVerdicts,
        evidence,
      }),
      maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
      signal: input.signal,
    });
    content = answer.content;
    if (answer.usage !== undefined) {
      costUsd = completionCostUsd(answer.usage, input.pricing) ?? null;
    }
  } catch (err) {
    return {
      green: false,
      items: factVerdicts,
      unverified: `the judge could not run: ${err instanceof Error ? err.message : String(err)}`,
      costUsd,
      review: { decision: "unverified", issues: [], reviewer },
    };
  }
  const ruled = parseJudgeAnswer(content);
  if (!ruled.ok) {
    return {
      green: false,
      items: factVerdicts,
      unverified: `the judge's answer could not be read (${ruled.error})`,
      costUsd,
      review: { decision: "unverified", issues: [], reviewer },
    };
  }
  const issues: ReviewIssue[] = ruled.issues.map((issue) => ({ ...issue, by: "reviewer" }));
  // An issue on an item the facts ruled on, on no item, or on an unknown
  // one is the work's as a whole: it lands on the instructions item, so
  // a blocking one still keeps the list red. Facts are not the judge's.
  const fallback =
    needsJudge.find((item) => item.kind === "instructions") ?? needsJudge[needsJudge.length - 1]!;
  const onItem = (issue: ReviewIssue): string =>
    issue.item !== null && needsJudge.some((item) => item.id === issue.item) ? issue.item : fallback.id;
  const judged = needsJudge.map((item): ItemVerdict => {
    const mine = issues.filter((issue) => onItem(issue) === item.id);
    const why = (list: readonly ReviewIssue[]): string =>
      list
        .map((issue) => (issue.item === item.id ? issue.why : `${issue.item === null ? "" : `[${issue.item}] `}${issue.why}`))
        .join("; ");
    const blocking = mine.filter(blocksAcceptance);
    if (blocking.length > 0) return { id: item.id, pass: false, why: why(blocking), by: "judge" };
    return {
      id: item.id,
      pass: true,
      why: mine.length === 0 ? "no issue found" : `minor: ${why(mine)}`,
      by: "judge",
    };
  });
  const all = [...factVerdicts, ...judged].sort(
    (a, b) => itemOrder(a.id) - itemOrder(b.id),
  );
  const green = all.every((v) => v.pass);
  // The decision follows the issues: a blocking one, whatever the
  // reviewer decided, is needs-changes; minors alone are an accept.
  return {
    green,
    items: all,
    costUsd,
    review: { decision: green ? "accept" : "needs-changes", issues, reviewer },
  };
}

function itemOrder(id: string): number {
  return Number.parseInt(id.slice(1), 10);
}

/** The items found not met; a skipped item is not a finding. */
export function redItems(verdict: JudgeVerdict): ItemVerdict[] {
  return verdict.items.filter((v) => !v.pass && v.by !== "skipped");
}

/** All failing-check output one retry brief carries. */
export const RETRY_OUTPUT_CHARS = 2 * CHECK_OUTPUT_CHARS;

/** The findings a retried worker is briefed with. */
export function renderRetryFindings(
  items: readonly AcceptanceItem[],
  verdict: JudgeVerdict,
): string {
  const red = redItems(verdict);
  // The failing checks' output, inside one task's share however many
  // failed (`RETRY_OUTPUT_CHARS`), each keeping its own tail.
  const withOutput = red.filter((v) => v.output !== undefined).length;
  const share =
    withOutput === 0
      ? 0
      : Math.min(CHECK_OUTPUT_CHARS, Math.floor(RETRY_OUTPUT_CHARS / withOutput));
  return [
    "## A judge found these acceptance items NOT met in your previous attempt",
    ...red.map((v) => {
      const item = items.find((i) => i.id === v.id);
      const line = `- [${v.id}] ${item?.text ?? ""} — ${v.why}`;
      return v.output === undefined
        ? line
        : `${line}\n  output:\n${tailClip(v.output, share).replace(/^/gm, "    ")}`;
    }),
    "Fix exactly these. The files from the previous attempt are on disk; change them rather than starting over.",
  ].join("\n");
}

/**
 * A review's remaining issues for the next pass's brief (issue #38):
 * severity, file and item first, then why. Undefined when it has none.
 */
export function renderReviewIssues(review: ReviewVerdict): string | undefined {
  if (review.issues.length === 0) return undefined;
  return [
    "## Remaining review issues (severity, file, item): fix every blocker and major",
    ...review.issues.map(
      (issue) =>
        `- ${issue.severity}${issue.file === null ? "" : ` ${issue.file}`}${issue.item === null ? "" : ` [${issue.item}]`}: ${issue.why.replace(/\s+/g, " ")}`,
    ),
  ].join("\n");
}

export interface JudgeSummary {
  green: boolean;
  total: number;
  failed: number;
  retried: boolean;
  /** Review passes the task got with a fusion team (issue #38); absent without one. */
  passes?: number;
  unverified?: string;
  costUsd: number | null;
  items: ItemVerdict[];
  /** The structured review (issue #38); absent on summaries from before it. */
  review?: ReviewVerdict;
}

/** Fold a verdict into the task's row: a node closes only on a green list. */
export function applyJudgeVerdict(
  result: WorkerTaskResult,
  verdict: JudgeVerdict,
  retried: boolean,
  /** With a fusion team (issue #38): the review passes the task got. */
  passes?: number,
): WorkerTaskResult {
  const red = redItems(verdict);
  const summary: JudgeSummary = {
    green: verdict.green,
    total: verdict.items.length,
    failed: red.length,
    retried,
    ...(passes === undefined ? {} : { passes }),
    ...(verdict.unverified === undefined ? {} : { unverified: verdict.unverified }),
    costUsd: verdict.costUsd,
    items: verdict.items,
    review: verdict.review,
  };
  const after =
    passes === undefined
      ? retried ? " after one retry" : ""
      : passes > 0 ? ` after ${passes} review pass${passes === 1 ? "" : "es"}` : "";
  if (verdict.unverified !== undefined) {
    return {
      ...result,
      status: "needs_orchestrator",
      judge: summary,
      notes: [
        ...(result.notes ?? []),
        `judge: not verified${after} — ${verdict.unverified}; the task stays open`,
      ],
    };
  }
  if (verdict.green) {
    return {
      ...result,
      judge: summary,
      notes: [
        ...(result.notes ?? []),
        `judge: all ${verdict.items.length} acceptance items green${after}`,
      ],
    };
  }
  const detail = red.map((v) => `${v.id} ${v.why}`).join("; ");
  const skipped = verdict.items.length - verdict.items.filter((v) => v.by !== "skipped").length;
  const error = `judge: ${red.length} of ${verdict.items.length} acceptance items not met${after} — ${detail}${skipped > 0 ? ` (${skipped} not judged)` : ""}`;
  return {
    ...result,
    status: "failed",
    judge: summary,
    error: result.error === undefined ? error : `${error}; ${result.error}`,
  };
}
