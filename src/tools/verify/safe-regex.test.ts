import { describe, expect, it } from "vitest";

import { compileCheckRegex, MAX_CHECK_REGEX_CHARS, testCheckRegex } from "./safe-regex.js";

describe("check regex policy (issue #40)", () => {
  it("reads a /source/flags literal with the allowed flags", () => {
    expect(compileCheckRegex("/^\\d+ passed$/m")).toEqual({ source: "^\\d+ passed$", flags: "m" });
    expect(compileCheckRegex("/a\\/b/iu")).toEqual({ source: "a\\/b", flags: "iu" });
    expect(compileCheckRegex("/x/")).toEqual({ source: "x", flags: "" });
  });

  it("refuses what is not a literal, unknown or repeated flags, an empty or invalid pattern", () => {
    expect(compileCheckRegex("a+b")).toMatchObject({ error: expect.stringContaining("/pattern/flags") });
    expect(compileCheckRegex("/a/g")).toMatchObject({ error: expect.stringContaining("flag") });
    expect(compileCheckRegex("/a/ii")).toMatchObject({ error: expect.stringContaining("flag") });
    expect(compileCheckRegex("//")).toMatchObject({ error: expect.stringContaining("empty") });
    expect(compileCheckRegex("/(a/")).toMatchObject({ error: expect.stringContaining("invalid") });
  });

  it("caps the pattern length", () => {
    expect(compileCheckRegex(`/${"a".repeat(MAX_CHECK_REGEX_CHARS)}/`)).not.toHaveProperty("error");
    expect(compileCheckRegex(`/${"a".repeat(MAX_CHECK_REGEX_CHARS + 1)}/`)).toMatchObject({ error: expect.stringContaining(`${MAX_CHECK_REGEX_CHARS}`) });
  });

  it("refuses a repeated group that itself repeats or alternates, and backreferences", () => {
    for (const bad of ["/(a+)+$/", "/(?:\\w*)*x/", "/(a|aa)*b/", "/(x{2,})+/", "/((ab)*c)+/", "/(a)\\1/", "/(?<n>a)\\k<n>/"]) {
      expect(compileCheckRegex(bad), bad).toMatchObject({ error: expect.any(String) });
    }
    // Escaped and in-class characters are not quantifiers; a bounded `?` is fine.
    for (const good of ["/(\\+\\*)+/", "/([+*|])+/", "/(ab)+/", "/(a+)?b/", "/\\d+ passed, (\\d+) failed/"]) {
      expect(compileCheckRegex(good), good).not.toHaveProperty("error");
    }
  });

  it("matches within a time bound and reports a pattern that runs too long instead of hanging", () => {
    expect(testCheckRegex({ source: "^ok$", flags: "m" }, "x\nok\ny")).toEqual({ matched: true });
    expect(testCheckRegex({ source: "^OK$", flags: "" }, "ok")).toEqual({ matched: false });
    const started = Date.now();
    const slow = testCheckRegex({ source: "\\s*\\s*\\s*\\s*x", flags: "" }, " ".repeat(20_000), 50);
    expect(slow).toMatchObject({ error: expect.stringContaining("time") });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
