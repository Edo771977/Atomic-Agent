import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
it("documents the per-call archive lifetime of skill reviews", () => {
  const guide = readFileSync(new URL("./README.md", import.meta.url), "utf8");
  expect(guide).toContain("Skill reviews use a fresh archive for each provider call.");
  expect(guide).toContain("`learn:<id>`");
});
