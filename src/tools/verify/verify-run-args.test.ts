import { describe, expect, it } from "vitest";

import { parseVerifyRunArgs, VERIFY_STDIN_MAX_BYTES } from "./verify-run-args.js";

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
