import { expect, it } from "vitest";
import { boundedHtmlToMarkdown } from "./html-markdown.js";

it("keeps text after a series of whitespace-only pre blocks in plain fallback", () => {
  const blank = "<pre>" + " ".repeat(20) + "</pre>";
  const warnings: string[] = [];
  const result = boundedHtmlToMarkdown("<p>VIS</p>" + blank.repeat(29_000) + "<p>TAILX</p>", warnings);
  expect(result.text.startsWith("VIS")).toBe(true);
  expect(result.text.endsWith("TAILX")).toBe(true);
  expect(warnings.some((warning) => /plain text was truncated/i.test(warning))).toBe(false);
});
