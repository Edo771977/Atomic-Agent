/**
 * The periodic watch on a running fusion worker (issue #43), team runs
 * only. Every interval a deterministic check compares the worker's
 * progress with the last check's: new steps, output tokens streamed,
 * files changed in its workspace, whether the server answered at all.
 * That check never stops work by itself; it only decides whether to ask
 * a judge (the task's reviewer, else the director). Clear progress costs
 * nothing. Unclear progress, or none for two intervals, asks the judge,
 * at most `maxJudgeCalls` times per task.
 *
 * The judge answers strict JSON (`parseWatchAnswer`); anything else is
 * read as progressing. `looping` / `off-track` deliver its hint to the
 * worker (`onHint`, the advisor's steering path); `stuck` stops the task
 * (`onStuck`). Pure apart from its own timer, which is unref'd, never
 * overlaps a judge call, and is cleared on `stop()` and on abort.
 */

/** What the judge may say of a worker. */
export type WatchState = "progressing" | "looping" | "stuck" | "off-track";

const WATCH_STATES: ReadonlySet<string> = new Set<WatchState>(["progressing", "looping", "stuck", "off-track"]);

/** A judge's hint, at most this long; longer ones are clipped. */
export const WATCH_HINT_MAX_CHARS = 300;

/** Intervals without clear progress before the judge is asked. */
export const WATCH_QUIET_INTERVALS = 2;

/** The output ceiling of one watch judge call: a state and a short hint. */
export const WATCH_JUDGE_MAX_OUTPUT_TOKENS = 200;

/** One look at a running worker, all counts since the task started. */
export interface WatchProgress {
  /** Steps finished (`step_finished`). */
  steps: number;
  /** Output tokens: completions' counts, plus streamed text not yet completed. */
  outputTokens: number;
  /** Files the worker's tools changed in its workspace. */
  filesChanged: number;
  /** The server produced a first token for this worker (token-level liveness). */
  served: boolean;
  /** The recent steps look stalled (`detectStall`). */
  stalled: boolean;
}

/**
 * How `next` compares with `prev`. `waiting`: the server has not
 * answered yet (the queue watchdog's business). `clear`: a file changed,
 * or steps finished that do not look stalled. `unclear`: steps finished
 * but look stalled. `streaming`: tokens without a finished step.
 * `none`: nothing moved.
 */
export type WatchProgressKind = "waiting" | "clear" | "unclear" | "streaming" | "none";

export function progressKind(prev: WatchProgress, next: WatchProgress): WatchProgressKind {
  if (!next.served) return "waiting";
  if (next.filesChanged > prev.filesChanged) return "clear";
  if (next.steps > prev.steps) return next.stalled ? "unclear" : "clear";
  if (next.outputTokens > prev.outputTokens) return "streaming";
  return "none";
}

/**
 * Whether this check asks the judge. `quietIntervals` is how many checks
 * in a row before this one saw no clear progress.
 */
export function decideWatch(
  prev: WatchProgress,
  next: WatchProgress,
  quietIntervals: number,
): "ok" | "judge" {
  const kind = progressKind(prev, next);
  if (kind === "waiting" || kind === "clear") return "ok";
  if (kind === "unclear") return "judge";
  return quietIntervals + 1 >= WATCH_QUIET_INTERVALS ? "judge" : "ok";
}

/** A judge's readable answer. */
export interface WatchAnswer {
  state: WatchState;
  hint: string | null;
}

/**
 * The judge's answer, or null when it is not exactly the JSON asked for
 * (a fenced block is accepted). Null is read as progressing: a bad parse
 * never stops work.
 */
export function parseWatchAnswer(content: string): WatchAnswer | null {
  let text = content.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/.exec(text);
  if (fenced !== null) text = fenced[1]!.trim();
  if (!text.startsWith("{")) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.state !== "string" || !WATCH_STATES.has(record.state)) return null;
  const rawHint = record.hint;
  if (rawHint !== undefined && rawHint !== null && typeof rawHint !== "string") return null;
  const hint = typeof rawHint === "string" ? rawHint.replace(/\s+/g, " ").trim().slice(0, WATCH_HINT_MAX_CHARS) : "";
  return { state: record.state as WatchState, hint: hint.length === 0 ? null : hint };
}

const WATCH_BRIEF_CHARS = 2_000;
const WATCH_FINDINGS_CHARS = 1_500;

/** The judge's prompt: the brief, what the worker did recently, the counts, and the answer's exact shape. */
export function renderWatchJudgePrompt(input: {
  brief: string;
  findings: string;
  before: WatchProgress;
  now: WatchProgress;
  intervalMinutes: number;
  /** Checks in a row without clear progress, this one included. */
  quietIntervals: number;
}): string {
  const clip = (text: string, max: number): string =>
    text.length > max ? `${text.slice(0, max)}\n[… truncated]` : text;
  const count = (label: string, now: number, before: number): string =>
    `- ${label}: ${now} (+${Math.max(0, now - before)})`;
  return [
    "You watch a worker model that is running a delegated coding task. Decide from the facts below whether it is still making progress.",
    "",
    "## Task brief",
    clip(input.brief.trim(), WATCH_BRIEF_CHARS),
    "",
    `## Progress (since the task started; in brackets, the last ${input.intervalMinutes} min)`,
    count("steps finished", input.now.steps, input.before.steps),
    count("output tokens", input.now.outputTokens, input.before.outputTokens),
    count("files changed", input.now.filesChanged, input.before.filesChanged),
    `- recent steps look stalled (same result repeated, or only reads): ${input.now.stalled ? "yes" : "no"}`,
    `- checks in a row without clear progress: ${input.quietIntervals}`,
    "",
    "## Its latest tool results",
    clip(input.findings.trim().length === 0 ? "(none yet)" : input.findings.trim(), WATCH_FINDINGS_CHARS),
    "",
    "## Answer",
    "Reply with exactly one JSON object and nothing else:",
    '{"state":"progressing"|"looping"|"stuck"|"off-track","hint":string|null}',
    `- progressing: let it work. looping: it repeats itself. off-track: it works on something the brief did not ask for. stuck: it cannot finish this way; it will be stopped and handed back.`,
    `- hint: for looping or off-track, one concrete instruction for the worker (at most ${WATCH_HINT_MAX_CHARS} characters); otherwise null.`,
  ].join("\n");
}

/** The hint as the worker reads it, framed like the advisor's (`formatAdvisorSteer`). */
export function formatWatchSteer(judge: string, state: WatchState, hint: string): string {
  const what = state === "off-track" ? "drifted from the brief" : "repeat themselves";
  return `A check on your progress (${judge}) found your recent steps ${what}. Follow this unless your files show it is wrong:\n\n${hint.trim()}`;
}

/** What one judge call came to. */
export type WatchJudgeResult =
  | { kind: "answer"; content: string }
  /** Not sent (the budget, an unpriced judge under a $ cap): noted, not counted. */
  | { kind: "skipped"; reason: string }
  /** Sent and failed: counted, read as progressing. */
  | { kind: "failed"; reason: string };

export type WatchJudgeCall = (input: { prompt: string; signal: AbortSignal }) => Promise<WatchJudgeResult>;

/** The counts the outcome log and the status table carry (no text). */
export interface WatchRecord {
  /** Deterministic checks made. */
  checks: number;
  /** Judge calls sent. */
  judgeCalls: number;
  /** Hints delivered to the worker. */
  hints: number;
  /** The watch stopped the task as stuck. */
  stopped: boolean;
  /** The judge's label, null when none was named. */
  judge: string | null;
}

/** A timer the watch can be driven by; the global one by default. */
export interface WatchClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const globalClock: WatchClock = {
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface TaskWatchOptions {
  intervalMs: number;
  /** Judge calls this task may cost (`team.watchMaxChecks`). */
  maxJudgeCalls: number;
  judgeLabel: string | null;
  probe: () => WatchProgress;
  /** The judge prompt for this check (`renderWatchJudgePrompt`). */
  prompt: (before: WatchProgress, now: WatchProgress, quietIntervals: number) => string;
  judge: WatchJudgeCall;
  /** Deliver a hint; true when it reached the worker. */
  onHint: (state: WatchState, hint: string) => boolean;
  /** Stop the task as stuck. Called at most once. */
  onStuck: () => void;
  /** A fact for the row, each distinct one once. */
  onNote?: (note: string) => void;
  /** The task's and the turn's; aborting it ends the watch. */
  signal: AbortSignal;
  clock?: WatchClock;
}

export interface TaskWatch {
  stop(): void;
  record(): WatchRecord;
}

export function startTaskWatch(options: TaskWatchOptions): TaskWatch {
  const clock = options.clock ?? globalClock;
  const ended = new AbortController();
  const judgeSignal = AbortSignal.any([options.signal, ended.signal]);
  const record: WatchRecord = { checks: 0, judgeCalls: 0, hints: 0, stopped: false, judge: options.judgeLabel };
  const noted = new Set<string>();
  const note = (text: string): void => {
    if (noted.has(text)) return;
    noted.add(text);
    options.onNote?.(text);
  };
  let timer: unknown;
  let armed = false;
  let quiet = 0;
  let before: WatchProgress | undefined;

  const stop = (): void => {
    if (armed) clock.clearTimeout(timer);
    armed = false;
    if (!ended.signal.aborted) ended.abort();
    options.signal.removeEventListener("abort", stop);
  };
  const arm = (): void => {
    if (ended.signal.aborted || options.signal.aborted) return;
    armed = true;
    timer = clock.setTimeout(() => {
      armed = false;
      void tick();
    }, options.intervalMs);
  };
  const tick = async (): Promise<void> => {
    if (judgeSignal.aborted) return;
    const now = options.probe();
    const prev = before ?? { steps: 0, outputTokens: 0, filesChanged: 0, served: now.served, stalled: false };
    before = now;
    record.checks += 1;
    const kind = progressKind(prev, now);
    const decision = decideWatch(prev, now, quiet);
    if (kind === "clear") quiet = 0;
    else if (kind !== "waiting") quiet += 1;
    if (decision === "judge") {
      if (record.judgeCalls >= options.maxJudgeCalls) {
        note(`watch: ${record.judgeCalls} judge call${record.judgeCalls === 1 ? "" : "s"} used; not asked again`);
      } else {
        const result = await options.judge({ prompt: options.prompt(prev, now, quiet), signal: judgeSignal });
        if (judgeSignal.aborted) return;
        if (result.kind === "skipped") {
          note(`watch: judge not asked: ${result.reason}`);
        } else {
          record.judgeCalls += 1;
          // A judge that answered, readable or not, resets the count: the
          // next call needs two more quiet intervals or stalled steps.
          quiet = 0;
          const answer = result.kind === "answer" ? parseWatchAnswer(result.content) : null;
          if (answer?.state === "stuck") {
            record.stopped = true;
            stop();
            options.onStuck();
            return;
          }
          if ((answer?.state === "looping" || answer?.state === "off-track") && answer.hint !== null) {
            if (options.onHint(answer.state, answer.hint)) record.hints += 1;
          }
        }
      }
    }
    arm();
  };

  if (!options.signal.aborted) {
    options.signal.addEventListener("abort", stop, { once: true });
    arm();
  } else {
    ended.abort();
  }
  return { stop, record: () => ({ ...record }) };
}
