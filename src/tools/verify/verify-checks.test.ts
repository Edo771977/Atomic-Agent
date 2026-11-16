import { describe, expect, it } from "vitest";

import {
  type CheckSubject,
  evaluateCheck,
  evaluateChecks,
  tokenizeCheck,
} from "./verify-checks.js";

const COMMAND: CheckSubject = {
  kind: "command",
  exitCode: 1,
  stdout: "12 passed\n2 failed\n",
  stderr: "",
};

const PAGE: CheckSubject = {
  kind: "page",
  errors: [],
  consoleErrors: ["TypeError: x is null"],
  missingSelectors: ["# launch-btn"],
  probes: {
    lives: [[0, 3], [250, 3], [500, 2], [750, 1]],
    score: [[0, 0], [250, 10], [500, 20]],
    state: [[0, "menu"], [250, "menu"], [500, "playing"]],
  },
};

describe("tokenizeCheck", () => {
  it("keeps quoted strings whole and unescapes them", () => {
    expect(tokenizeCheck('stdout contains "all tests passed"')).toEqual([
      "stdout",
      "contains",
      "all tests passed",
    ]);
    expect(tokenizeCheck("stderr not contains 'a \\'b\\' c'")).toEqual([
      "stderr",
      "not",
      "contains",
      "a 'b' c",
    ]);
  });
});

describe("evaluateCheck", () => {
  it.each([null, 0, 1])("never treats a timed-out command's native exit code %s as a completed check", (exitCode) => {
    for (const check of ["exit 0", "exit 1", "exit != 0", "exit != 1"]) {
      expect(evaluateCheck(check, { kind: "command", exitCode, timedOut: true })).toMatchObject({
        ok: false, detail: "killed (timed out)",
      });
    }
  });

  it("exit: equality and inequality, with the actual code in the detail", () => {
    expect(evaluateCheck("exit 0", COMMAND)).toMatchObject({ ok: false, detail: "exit 1" });
    expect(evaluateCheck("exit != 0", COMMAND)).toMatchObject({ ok: true });
    expect(evaluateCheck("exit == 1", COMMAND)).toMatchObject({ ok: true });
    expect(evaluateCheck("exit 0", { kind: "command", exitCode: null, timedOut: true })).toMatchObject({
      ok: false,
      detail: "killed (timed out)",
    });
    expect(evaluateCheck("exit 0", PAGE).ok).toBe(false);
  });

  it("stdout / stderr contains, negated or not, over the full output", () => {
    expect(evaluateCheck('stdout contains "12 passed"', COMMAND).ok).toBe(true);
    expect(evaluateCheck('stdout not contains "failed"', COMMAND).ok).toBe(false);
    expect(evaluateCheck('stderr not contains "Error"', COMMAND).ok).toBe(true);
    expect(evaluateCheck("stdout contains", COMMAND).detail).toContain("unknown check");
  });

  it("stdout / stderr matches a /regex/flags literal, negated or not, with the safe regex policy (issue #40)", () => {
    expect(evaluateCheck("stdout matches /^\\d+ passed$/m", COMMAND)).toMatchObject({ ok: true });
    expect(evaluateCheck("stdout matches /^\\d+ PASSED$/m", COMMAND).ok).toBe(false);
    expect(evaluateCheck("stdout matches /^\\d+ PASSED$/mi", COMMAND).ok).toBe(true);
    expect(evaluateCheck("stdout not matches /failed: [1-9]/", COMMAND).ok).toBe(true);
    expect(evaluateCheck("stderr not matches /Error/", COMMAND).ok).toBe(true);
    // A pattern with spaces is read whole, not split into tokens.
    expect(evaluateCheck("stdout matches /2 failed\\n$/", COMMAND).ok).toBe(true);
    expect(evaluateCheck("stdout matches /(a+)+$/", COMMAND)).toMatchObject({ ok: false, detail: expect.stringContaining("refused") });
    expect(evaluateCheck("stdout matches a+b", COMMAND)).toMatchObject({ ok: false, detail: expect.stringContaining("/pattern/flags") });
    expect(evaluateCheck("stdout matches /x/", PAGE)).toMatchObject({ ok: false, detail: "no stdout for a page run" });
  });

  it("status: every request must answer with the code", () => {
    const service: CheckSubject = { kind: "service", requests: [{ status: 200 }, { status: 200 }] };
    expect(evaluateCheck("status 200", service).ok).toBe(true);
    expect(evaluateCheck("status 200", { kind: "service", requests: [{ status: 200 }, { status: 500 }] })).toMatchObject({
      ok: false,
      detail: "statuses: 200, 500",
    });
    expect(evaluateCheck("status 200", { kind: "service", requests: [] }).detail).toBe("no requests were made");
  });

  it("no errors and missing selectors are page checks", () => {
    expect(evaluateCheck("no errors", PAGE)).toMatchObject({
      ok: false,
      detail: "0 uncaught error(s), 1 console error(s)",
    });
    expect(evaluateCheck("no errors", { ...PAGE, consoleErrors: [] }).ok).toBe(true);
    expect(evaluateCheck("no errors", COMMAND).ok).toBe(false);
    expect(evaluateCheck("missing selectors 0", PAGE)).toMatchObject({ ok: false });
    expect(evaluateCheck("missing selectors 1", PAGE).ok).toBe(true);
    expect(evaluateCheck("missing selectors 0", COMMAND).ok).toBe(false);
  });

  it("probe trends and values", () => {
    expect(evaluateCheck("probe lives decreases", PAGE)).toMatchObject({ ok: true, detail: "lives: 3 → 1 over 4 samples" });
    expect(evaluateCheck("probe lives increases", PAGE).ok).toBe(false);
    expect(evaluateCheck("probe score increases", PAGE).ok).toBe(true);
    expect(evaluateCheck("probe score equals 20", PAGE).ok).toBe(true);
    expect(evaluateCheck("probe score equals 10", PAGE).ok).toBe(false);
    expect(evaluateCheck("probe state reaches playing", PAGE).ok).toBe(true);
    expect(evaluateCheck('probe state reaches "over"', PAGE)).toMatchObject({ ok: false });
    expect(evaluateCheck("probe state stays menu", PAGE)).toMatchObject({ ok: false, detail: "state was playing at sample 2" });
    expect(evaluateCheck("probe lives stays 3", { ...PAGE, probes: { lives: [[0, 3], [250, 3]] } }).ok).toBe(true);
    expect(evaluateCheck("probe state decreases", PAGE)).toMatchObject({ ok: false });
    expect(evaluateCheck("probe nothing decreases", PAGE).detail).toBe('no probe named "nothing"');
  });

  it("game assertions over the harness's per-game results (issue #40)", () => {
    const run = (index: number, winner: string | null, durationMs: number, moves: number, over: Partial<{ finished: boolean; errors: string[] }> = {}) => ({
      index, seed: index + 1, finished: over.finished ?? true, winner, moves, durationMs, errors: over.errors ?? [],
    });
    const games = (runs: ReturnType<typeof run>[]) => ({
      n: runs.length, played: runs.length, finished: runs.filter((r) => r.finished).length,
      errors: runs.reduce((n, r) => n + r.errors.length, 0), medianMs: 100, medianMoves: 10,
      winners: {}, runs,
    });
    const good: CheckSubject = { kind: "page", errors: [], consoleErrors: [], games: games([run(0, "X", 120, 9), run(1, "O", 90, 12), run(2, null, 300, 30)]) };
    expect(evaluateCheck("games finish", good)).toMatchObject({ ok: true, detail: "3 of 3 games finished" });
    expect(evaluateCheck("game errors 0", good)).toMatchObject({ ok: true });
    expect(evaluateCheck("game duration < 500", good)).toMatchObject({ ok: true, detail: expect.stringContaining("longest 300 ms") });
    expect(evaluateCheck("game duration < 300", good).ok).toBe(false);
    expect(evaluateCheck("game moves < 31", good).ok).toBe(true);
    expect(evaluateCheck("game moves < 30", good)).toMatchObject({ ok: false, detail: expect.stringContaining("game 3: 30 moves") });
    expect(evaluateCheck("game winner in [X, O, none]", good).ok).toBe(true);
    expect(evaluateCheck('game winner in ["X","O"]', good)).toMatchObject({ ok: false, detail: expect.stringContaining("game 3: none") });
    expect(evaluateCheck("game winners vary", good)).toMatchObject({ ok: true });

    const same: CheckSubject = { kind: "page", games: games([run(0, "X", 1, 1), run(1, "X", 1, 1), run(2, "X", 1, 1)]) };
    expect(evaluateCheck("game winners vary", same)).toMatchObject({ ok: false, detail: expect.stringContaining("every game: X") });
    const two: CheckSubject = { kind: "page", games: games([run(0, "X", 1, 1), run(1, "O", 1, 1)]) };
    expect(evaluateCheck("game winners vary", two)).toMatchObject({ ok: false, detail: expect.stringContaining("at least 3") });

    const bad: CheckSubject = { kind: "page", games: games([run(0, "X", 1, 5), run(1, null, 120_000, 400, { finished: false, errors: ["TypeError: board is null"] })]) };
    expect(evaluateCheck("games finish", bad)).toMatchObject({ ok: false, detail: expect.stringContaining("1 of 2 games finished") });
    expect(evaluateCheck("game errors 0", bad)).toMatchObject({ ok: false, detail: expect.stringContaining("TypeError: board is null") });
    // An unfinished game never passes a duration or moves bound.
    expect(evaluateCheck("game duration < 999999", bad).ok).toBe(false);
    expect(evaluateCheck("game moves < 999999", bad).ok).toBe(false);

    const missing: CheckSubject = { kind: "page", games: { ...games([]), n: 3, missingApi: "the page exposes no window.__game API; the brief requires it" } };
    for (const check of ["games finish", "game errors 0", "game duration < 10", "game moves < 10", "game winner in [X]", "game winners vary"]) {
      expect(evaluateCheck(check, missing), check).toMatchObject({ ok: false, detail: expect.stringContaining("no window.__game API") });
    }
    expect(evaluateCheck("games finish", PAGE)).toMatchObject({ ok: false, detail: expect.stringContaining("no games were played") });
    for (const check of ["game duration under 5", "game moves <", "game winner X", "games end"]) {
      expect(evaluateCheck(check, good).detail, check).toContain("unknown check");
    }
  });

  it("fails unknown syntax rather than passing it", () => {
    for (const spec of ["passes", "exit", "probe", "no", "no errors please", "probe x between 1 2"]) {
      const out = evaluateCheck(spec, PAGE);
      expect(out.ok, spec).toBe(false);
      expect(out.detail, spec).toContain("unknown check");
    }
  });

  it("evaluateChecks keeps the order of the specs", () => {
    expect(evaluateChecks(["exit != 0", "exit 0"], COMMAND).map((c) => [c.check, c.ok])).toEqual([
      ["exit != 0", true],
      ["exit 0", false],
    ]);
  });
});
