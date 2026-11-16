import { describe, expect, it } from "vitest";

import { parseVerifyRunArgs, VERIFY_GAME_DEFAULT_MS_PER_GAME, VERIFY_GAME_MAX_MS_PER_GAME, VERIFY_STDIN_MAX_BYTES } from "./verify-run-args.js";

describe("verify.run arguments — stdin (issue #40)", () => {
  it("keeps a command's stdin up to the byte cap", () => {
    expect(parseVerifyRunArgs({ kind: "command", cmd: "node", stdin: "abc" }).stdin).toBe("abc");
    expect(parseVerifyRunArgs({ kind: "command", cmd: "node", stdin: "x".repeat(VERIFY_STDIN_MAX_BYTES) }).stdin).toHaveLength(VERIFY_STDIN_MAX_BYTES);
    expect(parseVerifyRunArgs({ kind: "command", cmd: "node" }).stdin).toBeUndefined();
  });

  it("refuses an oversized, non-string or non-command stdin, naming the field", () => {
    expect(() => parseVerifyRunArgs({ kind: "command", cmd: "node", stdin: "é".repeat(VERIFY_STDIN_MAX_BYTES / 2 + 1) })).toThrow(/`stdin`.*64 KB/);
    expect(() => parseVerifyRunArgs({ kind: "command", cmd: "node", stdin: 3 })).toThrow(/`stdin` must be a string/);
    expect(() => parseVerifyRunArgs({ kind: "page", path: "index.html", stdin: "x" })).toThrow(/`stdin` applies to command runs/);
    // A default-filled empty string on another kind is not a stdin.
    expect(parseVerifyRunArgs({ kind: "page", path: "index.html", stdin: "" })).not.toHaveProperty("stdin");
  });
});

describe("verify.run arguments — game (issue #40)", () => {
  it("reads a page's game spec with its bounds", () => {
    expect(parseVerifyRunArgs({ kind: "page", path: "index.html", game: { games: 5, maxMsPerGame: 10_000, maxMoves: 200 } }).game).toEqual({ games: 5, maxMsPerGame: 10_000, maxMoves: 200 });
    expect(parseVerifyRunArgs({ kind: "page", path: "index.html", game: { games: 1 } }).game).toEqual({ games: 1, maxMsPerGame: VERIFY_GAME_DEFAULT_MS_PER_GAME });
    // Clamped to the maximum per game.
    expect(parseVerifyRunArgs({ kind: "page", path: "index.html", game: { games: 2, maxMsPerGame: 999_999 } }).game?.maxMsPerGame).toBe(VERIFY_GAME_MAX_MS_PER_GAME);
    expect(parseVerifyRunArgs({ kind: "page", path: "index.html" })).not.toHaveProperty("game");
    // A strict provider's default-filled `{games: 0, maxMsPerGame: 0}` is no game, on any kind.
    expect(parseVerifyRunArgs({ kind: "page", path: "index.html", game: { games: 0, maxMsPerGame: 0, maxMoves: 0 } })).not.toHaveProperty("game");
    expect(parseVerifyRunArgs({ kind: "command", cmd: "node", game: { games: 0 } })).not.toHaveProperty("game");
  });

  it("refuses an out-of-range or misplaced game spec, naming the field", () => {
    expect(() => parseVerifyRunArgs({ kind: "page", path: "i.html", game: { games: 1.5 } })).toThrow(/`game.games` must be an integer from 1 to 20/);
    expect(() => parseVerifyRunArgs({ kind: "page", path: "i.html", game: { games: 21 } })).toThrow(/`game.games`/);
    expect(() => parseVerifyRunArgs({ kind: "page", path: "i.html", game: { games: 2, maxMoves: -1 } })).toThrow(/`game.maxMoves`/);
    expect(() => parseVerifyRunArgs({ kind: "page", path: "i.html", game: "yes" })).toThrow(/`game` must be an object/);
    expect(() => parseVerifyRunArgs({ kind: "command", cmd: "node", game: { games: 1 } })).toThrow(/`game` applies to page runs/);
  });
});
