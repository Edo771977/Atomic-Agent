import { expect, it } from "vitest";
import { boundedHtmlToMarkdown } from "./html-markdown.js";

it.each([
  ["span", "<p><span>", ""],
  ["font", "<p><font>", ""],
  ["div", "<p><b><div>", "</div>"],
  ["b", "<p><b>", ""],
])("closes old paragraphs and keeps 300 links in %s markup", (_tag, open, close) => {
  const html = Array.from({ length: 300 }, (_, n) =>
    open + "Line " + n + ' <a href="/item/' + n + '">Link</a>' + close).join("");
  const warnings: string[] = [];
  const result = boundedHtmlToMarkdown(html, warnings).text;
  expect(result.match(/\[Link\]\(\/item\/\d+\)/g)).toHaveLength(300);
  expect(result).toMatch(/Line 0 \[Link\]\(\/item\/0\)[_\*]*\n\n/);
  expect(warnings).toEqual([]);
});
