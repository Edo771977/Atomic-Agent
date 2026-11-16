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
 * (`onStuck`) only when the counts agree (nothing moved this interval,
 * and at least `WATCH_QUIET_INTERVALS` quiet ones in a row); otherwise
 * it is read as looping. The judge reads the worker's tool output, so
 * text in it must not be able to stop the worker on its own. Pure apart from its own timer, which is unref'd, never
 * overlaps a judge call, and is cleared on `stop()` and on abort.
 */

import { frameUntrustedText } from "../untrusted-tool-output.js";

/** What the judge may say of a worker. */
export type WatchState = "progressing" | "looping" | "stuck" | "off-track";

const WATCH_STATES: ReadonlySet<string> = new Set<WatchState>(["progressing", "looping", "stuck", "off-track"]);

/** A judge's hint, at most this long; longer ones are clipped. */
export const WATCH_HINT_MAX_CHARS = 300;

/**
 * Checks in a row a request may await its first token and still read as
 * waiting. From the next one on the silence is `none`: judge-able, and
 * counted toward the quiet intervals, so a server that answers its
 * health check but never this request (#29) does not blind the watch
 * until the first-token timeout. A tool call in flight is not bounded
 * here; the task's own wall clock bounds it.
 */
export const WATCH_FIRST_TOKEN_WAIT_INTERVALS = 2;

/** Intervals without clear progress before the judge is asked. */
export const WATCH_QUIET_INTERVALS = 2;

/**
 * Output tokens one interval must stream, with no step finished and no
 * file changed, to count as clear progress: a worker writing a long
 * answer is working. At or below it (a trickle, a stuck stream) the
 * interval is `streaming`, and the judge reads the streamed tail.
 */
export const WATCH_STREAMING_FLOOR_TOKENS = 50;

/** The streamed text's tail the judge reads, at most this long. */
export const WATCH_TAIL_CHARS = 600;

/** The first check's jitter never passes this, nor a quarter of the interval. */
export const WATCH_FIRST_TICK_JITTER_MAX_MS = 30_000;

/**
 * How much later than the interval a task's first check runs: watches
 * started together (a wave's tasks) then do not all ask their judges in
 * the same instant, past a $ cap none of them alone would pass.
 */
export function watchFirstTickJitterMs(intervalMs: number, random: () => number = Math.random): number {
  const bound = Math.min(WATCH_FIRST_TICK_JITTER_MAX_MS, Math.floor(intervalMs / 4));
  const r = Math.min(Math.max(random(), 0), 1);
  return Math.min(Math.max(0, bound - 1), Math.floor(r * bound));
}

/** A judge call that has not answered by then is aborted and read as progressing. */
export const WATCH_JUDGE_TIMEOUT_MS = 60_000;

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
  /** The runner, not the worker, is busy (the worker's self-check runs its checks). */
  paused?: boolean;
  /**
   * Tool calls parsed and not yet executed in the current step. A long
   * one (a build, `verify.run`, `shell.exec`) is waiting, not stalled;
   * the task's own wall clock bounds it.
   */
  toolsInFlight?: number;
  /**
   * A request is out (a step started, or the last one finished) and its
   * first token has not arrived: slow prompt processing on a later step
   * is waiting, not stalled. The task's own wall clock bounds it.
   */
  awaitingFirstToken?: boolean;
}

/**
 * How `next` compares with `prev`. `waiting`: the server has not
 * answered yet (the queue watchdog's business), the runner is paused
 * on the worker's self-check, or, when no step finished and no file
 * changed, a tool call is still running or the next request has not
 * produced its first token (the watch bounds the latter to
 * `WATCH_FIRST_TOKEN_WAIT_INTERVALS` checks). `clear`: a file changed,
 * or steps finished that do not look stalled. `unclear`: steps finished
 * but look stalled, or more than `WATCH_STREAMING_FLOOR_TOKENS` streamed
 * (clear). `streaming`: fewer tokens than that, no finished step.
 * `none`: nothing moved.
 */
export type WatchProgressKind = "waiting" | "clear" | "unclear" | "streaming" | "none";

export function progressKind(prev: WatchProgress, next: WatchProgress): WatchProgressKind {
  if (!next.served || next.paused === true) return "waiting";
  if (next.filesChanged > prev.filesChanged) return "clear";
  if (next.steps > prev.steps) return next.stalled ? "unclear" : "clear";
  if (next.outputTokens - prev.outputTokens > WATCH_STREAMING_FLOOR_TOKENS) return "clear";
  if ((next.toolsInFlight ?? 0) > 0 || next.awaitingFirstToken === true) return "waiting";
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

/** The slice of an agent-loop event the probe reads; anything else is ignored. */
export interface WatchObservedEvent {
  type: string;
  event?: unknown;
}

/**
 * What the watch's probe counts from one worker turn's event stream:
 * steps finished, output tokens (completions' counts, plus streamed
 * text not yet completed at ~4 chars a token), the streamed tail, tool
 * calls in flight and whether a request still awaits its first token.
 * Read defensively: a malformed event never throws into the worker.
 */
export class WatchProbeTracker {
  private stepCount = 0;
  private completedTokens = 0;
  private streamedChars = 0;
  private tail = "";
  private inFlight = 0;
  private awaiting = false;
  private servedOnce = false;

  constructor(private readonly servedEvents: ReadonlySet<string>) {}

  observe(event: WatchObservedEvent): void {
    if (event.type === "step_started") this.awaiting = true;
    if (event.type === "step_finished") {
      this.stepCount += 1;
      this.inFlight = 0;
      this.awaiting = true;
      this.servedOnce = true;
      return;
    }
    if (event.type !== "llm_event" || typeof event.event !== "object" || event.event === null) return;
    const inner = event.event as { type?: unknown; text?: unknown; completion?: unknown };
    if (typeof inner.type !== "string") return;
    if (this.servedEvents.has(inner.type)) {
      this.servedOnce = true;
      this.awaiting = false;
    }
    if (inner.type === "assistant_delta" || inner.type === "reasoning_delta") {
      if (typeof inner.text === "string") {
        this.streamedChars += inner.text.length;
        this.tail = (this.tail + inner.text).slice(-WATCH_TAIL_CHARS);
      }
    } else if (inner.type === "tool_call_parsed") {
      this.inFlight += 1;
    } else if (inner.type === "tool_call_executed") {
      this.inFlight = Math.max(0, this.inFlight - 1);
    } else if (inner.type === "llm_completed") {
      const completion = inner.completion as
        | { usage?: { completionTokens?: unknown }; timing?: { predictedTokens?: unknown } }
        | undefined;
      const spent = completion?.usage?.completionTokens ?? completion?.timing?.predictedTokens ?? 0;
      if (typeof spent === "number" && Number.isFinite(spent)) this.completedTokens += Math.max(0, spent);
      this.streamedChars = 0;
    }
  }

  /** The end of the streamed text, for the judge of a trickling stream. */
  streamedTail(): string {
    return this.tail;
  }

  /** The counts now; what the tracker cannot see comes from the caller. */
  progress(extra: { filesChanged: number; stalled: boolean; served?: boolean; paused?: boolean }): WatchProgress {
    return {
      steps: this.stepCount,
      outputTokens: this.completedTokens + Math.ceil(this.streamedChars / 4),
      filesChanged: extra.filesChanged,
      served: extra.served ?? this.servedOnce,
      stalled: extra.stalled,
      ...(extra.paused === undefined ? {} : { paused: extra.paused }),
      toolsInFlight: this.inFlight,
      awaitingFirstToken: this.awaiting,
    };
  }
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
  /** The end of the text the worker streamed (framed as its own output, never instructions). */
  streamedTail?: string;
  /** Minutes a request has awaited its first token, at least, when that is why it is judged. */
  firstTokenWaitMinutes?: number;
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
    ...(input.firstTokenWaitMinutes === undefined
      ? []
      : [`- no first token for at least ${input.firstTokenWaitMinutes} min (request in flight), no tool running`]),
    "",
    "## Its latest tool results",
    input.findings.trim().length === 0
      ? "(none yet)"
      : frameUntrustedText(clip(input.findings.trim(), WATCH_FINDINGS_CHARS), "the watched worker's tool results"),
    "",
    ...(input.streamedTail === undefined || input.streamedTail.trim().length === 0
      ? []
      : [
          "## Its latest streamed text",
          frameUntrustedText(input.streamedTail.slice(-WATCH_TAIL_CHARS), "the watched worker's own output"),
          "",
        ]),
    "## Answer",
    "Reply with exactly one JSON object and nothing else:",
    '{"state":"progressing"|"looping"|"stuck"|"off-track","hint":string|null}',
    `- progressing: let it work. looping: it repeats itself. off-track: it works on something the brief did not ask for. stuck: it cannot finish this way; it will be stopped and handed back.`,
    `- hint: for looping or off-track, one concrete instruction for the worker (at most ${WATCH_HINT_MAX_CHARS} characters); otherwise null.`,
  ].join("\n");
}

/**
 * The hint as the worker reads it: advice to weigh, never an order. The
 * judge read the worker's own tool output, which may carry text written
 * to steer it, so the worker is told to check the hint against its brief
 * and its files.
 */
export function formatWatchSteer(judge: string, state: WatchState, hint: string): string {
  const what = state === "off-track" ? "drifted from the brief" : "repeat themselves";
  return `A check on your progress (${judge}) thinks your recent steps ${what}. Its suggestion is advisory: weigh it against your brief and your files, and set it aside where they show it is wrong.\n\n${hint.trim()}`;
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

/** Two runs' records as one (a task's local attempt and its re-run). */
export function mergeWatchRecords(a: WatchRecord | undefined, b: WatchRecord | undefined): WatchRecord | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return {
    checks: a.checks + b.checks,
    judgeCalls: a.judgeCalls + b.judgeCalls,
    hints: a.hints + b.hints,
    stopped: a.stopped || b.stopped,
    judge: b.judge ?? a.judge,
  };
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
  /** Added to the first interval only (`watchFirstTickJitterMs`); absent, none. */
  firstTickJitterMs?: number;
  /**
   * Judge calls this run of the task may still cost: what is left of
   * `team.watchMaxChecks` after the task's earlier runs (review passes).
   */
  maxJudgeCalls: number;
  /** The task's whole cap, named in the note once it is used; absent, `maxJudgeCalls`. */
  judgeCallCap?: number;
  /** How long one judge call may take (`WATCH_JUDGE_TIMEOUT_MS` when absent). */
  judgeTimeoutMs?: number;
  judgeLabel: string | null;
  probe: () => WatchProgress;
  /**
   * The judge prompt for this check (`renderWatchJudgePrompt`).
   * `firstTokenWaitMinutes`: set when a request awaiting its first token
   * for too long is why the judge is asked.
   */
  prompt: (
    before: WatchProgress,
    now: WatchProgress,
    quietIntervals: number,
    context?: { firstTokenWaitMinutes?: number },
  ) => string;
  judge: WatchJudgeCall;
  /** Deliver a hint; true when it reached the worker. */
  onHint: (state: WatchState, hint: string) => boolean;
  /** Stop the task as stuck. Called at most once. */
  onStuck: () => void;
  /**
   * Whether another path (the advisor) steered the worker since the last
   * check; read, and reset by the caller, once per check. True: this
   * check sends no hint, so two voices do not steer the same stall.
   */
  takeOtherSteer?: () => boolean;
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
  // Checks in a row that saw a request awaiting its first token.
  let firstTokenWaits = 0;
  let before: WatchProgress | undefined;

  const stop = (): void => {
    if (armed) clock.clearTimeout(timer);
    armed = false;
    if (!ended.signal.aborted) ended.abort();
    options.signal.removeEventListener("abort", stop);
  };
  let firstDelayMs = Math.max(0, options.firstTickJitterMs ?? 0);
  const arm = (): void => {
    if (ended.signal.aborted || options.signal.aborted) return;
    armed = true;
    const delay = options.intervalMs + firstDelayMs;
    firstDelayMs = 0;
    timer = clock.setTimeout(() => {
      armed = false;
      void tick();
    }, delay);
  };
  // One judge call, bounded by its own timeout: a judge that never
  // answers is read as progressing, and the watch goes on.
  const askJudge = async (prompt: string): Promise<WatchJudgeResult> => {
    const timeoutMs = options.judgeTimeoutMs ?? WATCH_JUDGE_TIMEOUT_MS;
    const timedOut = new AbortController();
    const signal = AbortSignal.any([judgeSignal, timedOut.signal]);
    const timer = setTimeout(() => timedOut.abort(new Error("watch judge timeout")), timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        options.judge({ prompt, signal }),
        new Promise<WatchJudgeResult>((resolve) => {
          onAbort = () => resolve({ kind: "failed", reason: "aborted" });
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
      if (timedOut.signal.aborted && !judgeSignal.aborted) {
        note(`watch: the judge did not answer within ${Math.round(timeoutMs / 1000)} s; read as progressing`);
      }
    }
  };
  const check = async (): Promise<"stopped" | "go-on"> => {
    const otherSteer = options.takeOtherSteer?.() === true;
    const now = options.probe();
    const prev = before ?? { steps: 0, outputTokens: 0, filesChanged: 0, served: now.served, stalled: false };
    before = now;
    record.checks += 1;
    let kind = progressKind(prev, now);
    // A first token awaited longer than `WATCH_FIRST_TOKEN_WAIT_INTERVALS`
    // checks (no tool running) is silence, not waiting.
    firstTokenWaits = now.awaitingFirstToken === true && (now.toolsInFlight ?? 0) === 0 ? firstTokenWaits + 1 : 0;
    const silent = kind === "waiting" && now.served && now.paused !== true && firstTokenWaits > WATCH_FIRST_TOKEN_WAIT_INTERVALS;
    if (silent) kind = "none";
    const decision = silent
      ? quiet + 1 >= WATCH_QUIET_INTERVALS
        ? "judge"
        : "ok"
      : decideWatch(prev, now, quiet);
    if (kind === "clear") quiet = 0;
    else if (kind !== "waiting") quiet += 1;
    if (decision !== "judge") return "go-on";
    if (record.judgeCalls >= options.maxJudgeCalls) {
      const cap = options.judgeCallCap ?? options.maxJudgeCalls;
      note(`watch: ${cap} judge call${cap === 1 ? "" : "s"} used; not asked again`);
      return "go-on";
    }
    const result = await askJudge(
      options.prompt(prev, now, quiet, silent
        ? { firstTokenWaitMinutes: Math.max(1, Math.round(((firstTokenWaits - 1) * options.intervalMs) / 60_000)) }
        : {}),
    );
    if (judgeSignal.aborted) return "stopped";
    if (result.kind === "skipped") {
      note(`watch: judge not asked: ${result.reason}`);
      return "go-on";
    }
    record.judgeCalls += 1;
    const answer = result.kind === "answer" ? parseWatchAnswer(result.content) : null;
    // Stuck stops work only when the counts agree; a judge steered by
    // what the worker read cannot stop a worker that moves.
    const counted = kind === "none" && quiet >= WATCH_QUIET_INTERVALS;
    if (answer?.state === "stuck" && !counted) answer.state = "looping";
    // A judge that answered, readable or not, resets the count: the
    // next call needs two more quiet intervals or stalled steps.
    quiet = 0;
    if (answer?.state === "stuck") {
      record.stopped = true;
      stop();
      options.onStuck();
      return "stopped";
    }
    if ((answer?.state === "looping" || answer?.state === "off-track") && answer.hint !== null) {
      if (otherSteer) note("watch: hint not sent: the advisor steered the worker in this interval");
      else if (options.onHint(answer.state, answer.hint)) record.hints += 1;
    }
    return "go-on";
  };
  const tick = async (): Promise<void> => {
    if (judgeSignal.aborted) return;
    try {
      if ((await check()) === "stopped") return;
    } catch (err) {
      // A check that throws (a probe, a prompt, a hint's delivery) never
      // ends the watch, nor reaches the worker.
      note(`watch: a check failed (${err instanceof Error ? err.message : String(err)}); the watch goes on`);
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
