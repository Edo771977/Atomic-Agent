/**
 * Issue #104 review: which spellings of a command check are one check.
 * Only one word with its args, or one line with no args, normalize; the
 * words must be plain (no `%`, quotes, spaces or shell metacharacters).
 */
import { describe, expect, it } from "vitest";

import { checkSpecKey } from "./worker-self-check.js";

const words = checkSpecKey({ kind: "command", cmd: "node", args: ["--test", "a.cjs"] });

describe("checkSpecKey (issue #104 review)", () => {
  it("one word with its args and one line with none are the same check", () => {
    expect(checkSpecKey({ kind: "command", cmd: "node --test a.cjs" })).toBe(words);
    expect(checkSpecKey({ cmd: "node --test a.cjs", args: [] })).toBe(words);
  });

  it("negatives: a split line, a % word, an env prefix, a quoted word", () => {
    expect(checkSpecKey({ kind: "command", cmd: "node --test", args: ["a.cjs"] })).not.toBe(words);
    expect(checkSpecKey({ cmd: "node --test %X%" })).not.toBe(checkSpecKey({ cmd: "node", args: ["--test", "%X%"] }));
    expect(checkSpecKey({ cmd: "NODE_OPTIONS=--require=./x.cjs node --test a.cjs" })).not.toBe(words);
    expect(checkSpecKey({ cmd: "node --test 'a.cjs'" })).not.toBe(words);
  });
});
