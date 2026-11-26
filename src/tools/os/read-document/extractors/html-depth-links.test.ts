import { expect, it } from "vitest";
import { boundedHtmlToMarkdown } from "./html-markdown.js";

it("keeps all 300 links and their breaks under nested div and paragraph tags", () => {
  const html = "<div class=x><p>Lead<br><a href='/ref'>Link</a>".repeat(300);
  const warnings: string[] = [];
  const result = boundedHtmlToMarkdown(html, warnings).text;
  expect(result.match(/\[Link\]\(\/ref\)/g)).toHaveLength(300);
  expect(result.match(/Lead\n\[Link\]/g)).toHaveLength(300);
  expect(warnings).toContainEqual(expect.stringMatching(/depth.*flattened/i));
});
