import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
it("documents the per-call archive contract for all auxiliary routing partitions", () => {
  const guide = readFileSync(new URL("./README.md", import.meta.url), "utf8");
  for (const prefix of ["btw:", "compaction:", "next-step:", "risk:", "browser-extract:", "reflection:", "rewriter:", "link-gen:", "vote:", "note-reconcile:"]) expect(guide).toContain(prefix);
  expect(guide).toContain("consolidator");
  expect(guide).toContain("skill-eval-judge");
  for (const path of ["../http/README.md", "../runtime/README.md"]) {
    const text = readFileSync(new URL(path, import.meta.url), "utf8");
    expect(text).not.toMatch(/archive (?:is released after the last overlapping|when its last overlapping)/);
  }
});
