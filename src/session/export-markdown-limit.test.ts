import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("documents the pre-existing raw HTML presentation limit of Markdown exports", () => {
  const guide = readFileSync(new URL("./README.md", import.meta.url), "utf8");
  expect(guide).toContain("Markdown viewers can hide raw HTML tags and comments");
  expect(guide).toContain("rejoin pieces of a known secret");
  expect(guide).toContain("pre-existing limitation");
});
it("documents the pre-existing stack-depth limit for nested quotes and lists", () => {
  const guide = readFileSync(new URL("./README.md", import.meta.url), "utf8");
  expect(guide).toContain("pre-existing stack-depth limit on main");
  expect(guide).toContain("Deeply nested block quotes and lists");
  expect(guide).toContain("RangeError");
});
