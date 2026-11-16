import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  WATCH_HINT_MAX_CHARS,
  decideWatch,
  formatWatchSteer,
  parseWatchAnswer,
  progressKind,
  renderWatchJudgePrompt,
  startTaskWatch,
  type WatchJudgeCall,
  type WatchProgress,
} from "./worker-watch.js";

const at = (over: Partial<WatchProgress> = {}): WatchProgress => ({
  steps: 0,
  outputTokens: 0,
  filesChanged: 0,
  served: true,
  stalled: false,
  ...over,
});

describe("progressKind and decideWatch (issue #43)", () => {
  it("clear progress costs nothing: a new file, or new steps that do not look stalled", () => {
    expect(progressKind(at(), at({ filesChanged: 1 }))).toBe("clear");
    expect(progressKind(at(), at({ steps: 2, outputTokens: 300 }))).toBe("clear");
    expect(decideWatch(at(), at({ filesChanged: 1 }), 5)).toBe("ok");
    expect(decideWatch(at(), at({ steps: 1 }), 1)).toBe("ok");
  });

  it("new steps that look stalled are unclear: the judge is asked at once", () => {
    expect(progressKind(at(), at({ steps: 3, stalled: true }))).toBe("unclear");
    expect(decideWatch(at(), at({ steps: 3, stalled: true }), 0)).toBe("judge");
  });

  it("no progress, or tokens without a finished step, asks the judge only after two intervals", () => {
    expect(progressKind(at({ steps: 2 }), at({ steps: 2 }))).toBe("none");
    expect(progressKind(at(), at({ outputTokens: 50 }))).toBe("streaming");
    expect(decideWatch(at(), at(), 0)).toBe("ok");
    expect(decideWatch(at(), at(), 1)).toBe("judge");
    expect(decideWatch(at(), at({ outputTokens: 50 }), 0)).toBe("ok");
    expect(decideWatch(at(), at({ outputTokens: 50 }), 1)).toBe("judge");
  });

  it("a worker the server has not answered yet is the queue watchdog's, never the judge's", () => {
    expect(progressKind(at({ served: false }), at({ served: false }))).toBe("waiting");
    expect(decideWatch(at({ served: false }), at({ served: false }), 9)).toBe("ok");
  });

  it("nor one whose runner is busy with its self-check", () => {
    expect(progressKind(at(), at({ paused: true }))).toBe("waiting");
    expect(decideWatch(at(), at({ paused: true, steps: 3, stalled: true }), 9)).toBe("ok");
  });
});

describe("parseWatchAnswer (issue #43)", () => {
  it("reads the strict answer, a fenced one too", () => {
    expect(parseWatchAnswer('{"state":"progressing","hint":null}')).toEqual({ state: "progressing", hint: null });
    expect(parseWatchAnswer('```json\n{"state":"looping","hint":"write the file now"}\n```')).toEqual({
      state: "looping",
      hint: "write the file now",
    });
    expect(parseWatchAnswer('{"state":"stuck"}')).toEqual({ state: "stuck", hint: null });
    expect(parseWatchAnswer('{"state":"off-track","hint":"   "}')).toEqual({ state: "off-track", hint: null });
  });

  it("clips a long hint to its bound", () => {
    const answer = parseWatchAnswer(JSON.stringify({ state: "looping", hint: "x".repeat(900) }));
    expect(answer?.hint?.length).toBe(WATCH_HINT_MAX_CHARS);
  });

  it("an unreadable answer is null, which the watch treats as progressing", () => {
    for (const bad of ["", "stuck", "{", '{"state":"dead"}', '{"state":"stuck","hint":3}', "[]", 'Sure! {"state":"stuck"}']) {
      expect(parseWatchAnswer(bad), bad).toBeNull();
    }
  });
});

describe("renderWatchJudgePrompt and formatWatchSteer", () => {
  it("asks for the strict JSON and carries the counts, the brief and the findings", () => {
    const prompt = renderWatchJudgePrompt({
      brief: "Fix parseDate in src/d.ts",
      findings: "os.fs.read ok: src/d.ts",
      before: at({ steps: 4 }),
      now: at({ steps: 4, outputTokens: 120 }),
      intervalMinutes: 5,
      quietIntervals: 2,
    });
    expect(prompt).toContain('{"state":"progressing"|"looping"|"stuck"|"off-track","hint":string|null}');
    expect(prompt).toContain("Fix parseDate in src/d.ts");
    expect(prompt).toContain("os.fs.read ok: src/d.ts");
    expect(prompt).toContain("steps finished: 4 (+0)");
    expect(prompt).toContain("output tokens: 120 (+120)");
  });

  it("frames the hint as the watcher's, like the advisor's", () => {
    expect(formatWatchSteer("model-r", "looping", "stop re-reading; write it")).toContain("stop re-reading; write it");
    expect(formatWatchSteer("model-r", "looping", "x")).toContain("model-r");
  });
});

describe("startTaskWatch (issue #43)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const setup = (answers: Array<Awaited<ReturnType<WatchJudgeCall>>>, progress: () => WatchProgress = () => at()) => {
    const controller = new AbortController();
    const judge = vi.fn<WatchJudgeCall>(async () => answers.shift() ?? { kind: "answer", content: '{"state":"progressing","hint":null}' });
    const onHint = vi.fn(() => true);
    const onStuck = vi.fn();
    const notes: string[] = [];
    const watch = startTaskWatch({
      intervalMs: 60_000,
      maxJudgeCalls: 2,
      judgeLabel: "model-r",
      probe: progress,
      prompt: () => "judge this",
      judge,
      onHint,
      onStuck,
      onNote: (note) => notes.push(note),
      signal: controller.signal,
    });
    return { controller, judge, onHint, onStuck, notes, watch };
  };

  it("checks every interval and calls nothing while the progress is clear", async () => {
    let files = 0;
    const { judge, watch } = setup([], () => at({ filesChanged: ++files }));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(judge).not.toHaveBeenCalled();
    expect(watch.record()).toEqual({ checks: 5, judgeCalls: 0, hints: 0, stopped: false, judge: "model-r" });
    watch.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("asks the judge after two quiet intervals and delivers a looping hint", async () => {
    const { judge, onHint, watch } = setup([{ kind: "answer", content: '{"state":"looping","hint":"write src/a.ts now"}' }]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(judge).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(judge).toHaveBeenCalledTimes(1);
    expect(judge.mock.calls[0]![0].prompt).toBe("judge this");
    expect(onHint).toHaveBeenCalledWith("looping", "write src/a.ts now");
    expect(watch.record()).toMatchObject({ checks: 2, judgeCalls: 1, hints: 1, stopped: false });
    watch.stop();
  });

  it("stops the task when the judge says stuck, and its timer with it", async () => {
    const { onStuck, watch } = setup([{ kind: "answer", content: '{"state":"stuck","hint":null}' }]);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(onStuck).toHaveBeenCalledTimes(1);
    expect(watch.record()).toMatchObject({ judgeCalls: 1, stopped: true });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(watch.record().checks).toBe(2);
  });

  it("never stops work on an unreadable answer or a failed call", async () => {
    const { onStuck, onHint, watch } = setup([
      { kind: "answer", content: "the worker looks stuck to me" },
      { kind: "failed", reason: "provider refused" },
    ]);
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(onStuck).not.toHaveBeenCalled();
    expect(onHint).not.toHaveBeenCalled();
    expect(watch.record()).toMatchObject({ judgeCalls: 2, stopped: false });
    watch.stop();
  });

  it("caps the judge calls and says so once", async () => {
    const { judge, notes, watch } = setup([]);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(judge).toHaveBeenCalledTimes(2);
    expect(notes.filter((n) => n.includes("not asked again"))).toHaveLength(1);
    watch.stop();
  });

  it("a skipped call is noted once and not counted", async () => {
    const { judge, notes, watch } = setup([
      { kind: "skipped", reason: "the turn budget needs a priced judge" },
      { kind: "skipped", reason: "the turn budget needs a priced judge" },
    ]);
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(judge).toHaveBeenCalledTimes(2);
    expect(watch.record().judgeCalls).toBe(0);
    expect(notes).toEqual(["watch: judge not asked: the turn budget needs a priced judge"]);
    watch.stop();
  });

  it("leaves no timer behind on abort, even with a judge call in flight", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const watch = startTaskWatch({
      intervalMs: 60_000,
      maxJudgeCalls: 3,
      judgeLabel: null,
      probe: () => at(),
      prompt: () => "p",
      judge: ({ signal }) => {
        seen = signal;
        return new Promise((resolve) => signal.addEventListener("abort", () => resolve({ kind: "failed", reason: "aborted" })));
      },
      onHint: () => true,
      onStuck: () => {},
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(seen?.aborted).toBe(false);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(watch.record().checks).toBe(2);
  });

  it("does not start at all on an aborted signal", () => {
    const controller = new AbortController();
    controller.abort();
    startTaskWatch({
      intervalMs: 60_000,
      maxJudgeCalls: 3,
      judgeLabel: null,
      probe: () => at(),
      prompt: () => "p",
      judge: async () => ({ kind: "failed", reason: "x" }),
      onHint: () => true,
      onStuck: () => {},
      signal: controller.signal,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses an injected clock when given one", () => {
    const calls: number[] = [];
    const watch = startTaskWatch({
      intervalMs: 1234,
      maxJudgeCalls: 1,
      judgeLabel: null,
      probe: () => at(),
      prompt: () => "p",
      judge: async () => ({ kind: "failed", reason: "x" }),
      onHint: () => true,
      onStuck: () => {},
      signal: new AbortController().signal,
      clock: {
        setTimeout: (_fn, ms) => {
          calls.push(ms);
          return 1;
        },
        clearTimeout: () => calls.push(-1),
      },
    });
    watch.stop();
    expect(calls).toEqual([1234, -1]);
  });
});
