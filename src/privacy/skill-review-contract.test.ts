import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
it("documents the retained registry lifetime of skill reviews", () => {
  const guide = readFileSync(new URL("./README.md", import.meta.url), "utf8");
  expect(guide).toContain("Skill reviews release their temporary archives at completion.");
  expect(guide).toContain("`learn:<id>`");
});
