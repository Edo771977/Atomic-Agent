import { existsSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { DEFAULT_TOOL_DESCRIPTORS } from "../prompt/tool-descriptors.js";

it("C1e: keeps the subagent execution surface absent until its boundaries pass", () => {
  expect(existsSync(new URL("./subagent/subagent-run.ts", import.meta.url))).toBe(false);
});

it("C1e: offers no subagent tool in the production catalog", () => {
  expect(DEFAULT_TOOL_DESCRIPTORS.some(tool => tool.name === "subagent.run")).toBe(false);
});

it("C1e: keeps the production grammar free of the deferred verb", () => {
  expect(readFileSync(new URL("../../grammars/tool-call.gbnf", import.meta.url), "utf8")).not.toContain("subagent.run");
});
