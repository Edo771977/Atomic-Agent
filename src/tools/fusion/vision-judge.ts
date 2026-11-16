import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { maskSecrets, type KnownSecret } from "../../error-reporting/secret-detector.js";
import type { CompletionUsage } from "../../llm/provider/completion-types.js";
import type { TeamMember } from "../../llm/run-mode/fusion-team.js";
import { frameUntrustedText } from "../untrusted-tool-output.js";
import type { ContractCheckOutcome } from "./contract-checks.js";
import type { DelegateContract } from "./contract.js";
import type { TaskCriterion, VisionCriterionVerdict } from "./criteria-facts.js";

/**
 * The vision judge (issue #40): a visual contract check's screenshots
 * (`judge: "vision"`) judged against the success criteria it names.
 *
 * The judge is the task's reviewer when it can see, else the next team
 * reviewer that can, else the provider `vision.describe` routes to;
 * none: every visual criterion is `unverified`, which keeps the task
 * from closing on its own (`criteria-facts.ts`). The call goes through
 * the registry's guarded provider (the folder's provider policy); a
 * refusal, an error, an unreadable answer or a call the turn's budget
 * skips is `unverified` too. The answer is strict JSON, one entry per
 * criterion; vision can only add red or unverified — a red check stays
 * red whatever it says (`criteriaFactsFor`).
 */

/** One describe call, through the guarded provider. Throws on a refusal. */
export type VisionDescribe = (call: {
  providerId: string;
  /** The member's model, when its provider can ask for one. */
  model?: string;
  prompt: string;
  imagePaths: readonly string[];
  maxTokens: number;
  signal: AbortSignal;
}) => Promise<{ text: string; usage?: CompletionUsage }>;

/** At most this many screenshots per call (a run takes at most four). */
export const VISION_MAX_IMAGES = 4;
/** The page's text excerpt, framed as untrusted, at most this long. */
export const VISION_PAGE_TEXT_CHARS = 1_500;
export const VISION_TITLE_CHARS = 200;
export const VISION_WHY_CHARS = 200;
export const VISION_MAX_OUTPUT_TOKENS = 1_500;
/** What one screenshot is assumed to cost in prompt characters, for a worst-case price. */
export const VISION_IMAGE_PROMPT_CHARS = 6_400;
/** How much of the checked page file is read for its title and text. */
const PAGE_READ_BYTES = 256 * 1024;

export function pickVisionJudge(input: {
  taskReviewer: TeamMember | null;
  reviewers: readonly TeamMember[];
  sees: (member: TeamMember) => boolean;
  route: () => TeamMember | null;
}): TeamMember | null {
  if (input.taskReviewer !== null && input.sees(input.taskReviewer)) return input.taskReviewer;
  const next = input.reviewers.find((m) => m.ref !== input.taskReviewer?.ref && input.sees(m));
  if (next !== undefined) return next;
  const route = input.route();
  return route !== null && input.sees(route) ? route : null;
}

export function renderVisionPrompt(input: {
  criteria: ReadonlyArray<{ id: string; text: string }>;
  pageTitle?: string;
  pageText?: string;
}): string {
  const example = input.criteria[0]?.id ?? "c1";
  const title = input.pageTitle?.replace(/\s+/g, " ").trim().slice(0, VISION_TITLE_CHARS);
  const text = input.pageText?.slice(0, VISION_PAGE_TEXT_CHARS);
  return [
    "You are a strict visual acceptance judge. The images are screenshots of a web page a worker built. For each success criterion below, decide from the screenshots alone whether it is met. If the screenshots do not show that a criterion is met, it is not met.",
    "",
    "## Success criteria",
    ...input.criteria.map((c) => `- ${c.id}: ${c.text.length === 0 ? "(no text in the brief)" : c.text}`),
    "",
    ...(title === undefined || title.length === 0 ? [] : ["## Page title", frameUntrustedText(title, "the page under test"), ""]),
    ...(text === undefined || text.trim().length === 0 ? [] : ["## Page text (excerpt)", frameUntrustedText(text, "the page under test"), ""]),
    `Answer with JSON only: an array with one entry per criterion above, exactly this shape and no other keys: [{"criterion":"${example}","met":true|false,"why":"…"}]`,
    `- why: one line, at most ${VISION_WHY_CHARS} characters, naming what the screenshots show.`,
  ].join("\n");
}

export type ParsedVisionAnswer =
  | { ok: true; verdicts: Map<string, VisionCriterionVerdict> }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The answer, strictly: the JSON array in the content, each entry
 * exactly `criterion` (one of `ids`, once), `met` (boolean) and `why`
 * (non-blank, at most {@link VISION_WHY_CHARS}). Nothing is repaired.
 * A criterion the answer leaves out has no verdict (unverified).
 */
export function parseVisionAnswer(content: string, ids: readonly string[]): ParsedVisionAnswer {
  const start = content.indexOf("[");
  const end = content.lastIndexOf("]");
  if (start === -1 || end <= start) return { ok: false, error: "no JSON array" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return { ok: false, error: "not valid JSON" };
  }
  if (!Array.isArray(parsed)) return { ok: false, error: "not an array" };
  const verdicts = new Map<string, VisionCriterionVerdict>();
  for (const [i, entry] of parsed.entries()) {
    if (!isRecord(entry) || Object.keys(entry).length !== 3 || !["criterion", "met", "why"].every((k) => Object.hasOwn(entry, k))) {
      return { ok: false, error: `entry ${i + 1}: expected exactly criterion, met and why` };
    }
    const { criterion, met, why } = entry;
    if (typeof criterion !== "string" || !ids.includes(criterion) || verdicts.has(criterion)) {
      return { ok: false, error: `entry ${i + 1}: criterion` };
    }
    if (typeof met !== "boolean") return { ok: false, error: `entry ${i + 1}: met` };
    if (typeof why !== "string" || why.trim().length === 0 || why.length > VISION_WHY_CHARS) {
      return { ok: false, error: `entry ${i + 1}: why` };
    }
    verdicts.set(criterion, { state: met ? "passed" : "failed", why: why.replace(/\s+/g, " ").trim() });
  }
  return { ok: true, verdicts };
}

/** The checked page's title and visible text, masked; nothing when it cannot be read. */
async function pageExcerpt(
  path: unknown,
  workingDir: string,
  known: readonly KnownSecret[],
): Promise<{ pageTitle?: string; pageText?: string }> {
  if (typeof path !== "string" || path.length === 0) return {};
  let html: string;
  try {
    const raw = await readFile(isAbsolute(path) ? path : resolve(workingDir, path));
    html = raw.subarray(0, PAGE_READ_BYTES).toString("utf8");
  } catch {
    return {};
  }
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim();
  const body = html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<title[^>]*>[\s\S]*?<\/title>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return {
    ...(title === undefined || title.length === 0 ? {} : { pageTitle: maskSecrets(title, known) }),
    ...(body.length === 0 ? {} : { pageText: maskSecrets(body, known).slice(0, VISION_PAGE_TEXT_CHARS) }),
  };
}

export interface TaskVisionResult {
  /** Criterion id → verdict, for the criteria a green visual check with screenshots names. */
  judgements: Map<string, VisionCriterionVerdict>;
  costUsd: number | null;
  /** The judge asked, `provider:model`; null when none was. */
  judge: string | null;
  /** Why no judgement was reached, when none was. */
  note?: string;
}

/**
 * Judge one task's visual checks. Never throws; every failure is an
 * `unverified` verdict for each criterion it concerns.
 */
export async function judgeTaskVision(input: {
  taskId: string;
  criteria: readonly TaskCriterion[];
  contract: DelegateContract | undefined;
  outcomes: readonly (ContractCheckOutcome | undefined)[];
  workingDir: string;
  judge: TeamMember | null;
  pinsModel: (providerId: string) => boolean;
  describe: VisionDescribe | undefined;
  /** The turn's budget gate: a reason the call may not be made (unpriced under a $ cap, over the cap). */
  admit: (judge: TeamMember, worstPromptChars: number) => string | undefined;
  /** The call's price from its usage; null when unknown. */
  price: (judge: TeamMember, usage: CompletionUsage | undefined) => number | null;
  knownSecrets?: readonly KnownSecret[];
  signal: AbortSignal;
}): Promise<TaskVisionResult> {
  const checks = input.contract?.checks ?? [];
  const visual = new Set<number>();
  const images: string[] = [];
  let pagePath: unknown;
  checks.forEach((check, index) => {
    if (check.task !== input.taskId || check.judge !== "vision") return;
    const outcome = input.outcomes[index];
    if (outcome === undefined || !outcome.ok) return;
    if ((outcome.screenshotErrors?.length ?? 0) > 0 || (outcome.screenshots?.length ?? 0) === 0) return;
    visual.add(index);
    pagePath ??= check.path;
    for (const shot of outcome.screenshots!) if (images.length < VISION_MAX_IMAGES && !images.includes(shot.path)) images.push(shot.path);
  });
  const judged = input.criteria.filter((c) => c.checkIndexes.some((i) => visual.has(i)));
  const judgements = new Map<string, VisionCriterionVerdict>();
  if (judged.length === 0) return { judgements, costUsd: null, judge: null };
  const unverified = (why: string, judge: string | null, costUsd: number | null = null): TaskVisionResult => {
    for (const c of judged) judgements.set(c.id, { state: "unverified", why });
    return { judgements, costUsd, judge, note: why };
  };
  if (input.judge === null || input.describe === undefined) {
    return unverified("no vision-capable reviewer is available to judge the screenshots", null);
  }
  const judge = input.judge;
  const label = `${judge.providerId}:${judge.model}`;
  const known = input.knownSecrets ?? [];
  const prompt = renderVisionPrompt({
    criteria: judged.map((c) => ({ id: c.id, text: c.text })),
    ...(await pageExcerpt(pagePath, input.workingDir, known)),
  });
  const refused = input.admit(judge, prompt.length + images.length * VISION_IMAGE_PROMPT_CHARS);
  if (refused !== undefined) return unverified(`the vision judge was not asked: ${refused}`, null);
  let answer: Awaited<ReturnType<VisionDescribe>>;
  try {
    answer = await input.describe({
      providerId: judge.providerId,
      ...(input.pinsModel(judge.providerId) ? { model: judge.model } : {}),
      prompt,
      imagePaths: images,
      maxTokens: VISION_MAX_OUTPUT_TOKENS,
      signal: input.signal,
    });
  } catch (err) {
    return unverified(`the vision judge could not run: ${maskSecrets(err instanceof Error ? err.message : String(err), known)}`, label);
  }
  const costUsd = input.price(judge, answer.usage);
  const parsed = parseVisionAnswer(answer.text, judged.map((c) => c.id));
  if (!parsed.ok) return unverified(`the vision judge's answer could not be read (${parsed.error})`, label, costUsd);
  for (const c of judged) {
    judgements.set(c.id, parsed.verdicts.get(c.id) ?? { state: "unverified", why: "the vision judge gave no verdict for it" });
  }
  return { judgements, costUsd, judge: label };
}
