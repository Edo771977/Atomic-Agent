import { expect, it } from "vitest";
import { boundedHtmlToMarkdown } from "./html-markdown.js";

it("keeps Markdown formatting when source indentation collapses during conversion", () => {
  const html = "<h2>Contents</h2>\n" +
    (" ".repeat(120) + "<p>Paragraph</p>\n").repeat(4900) +
    '<p><a href="/tail">TAILX</a></p>';
  const warnings: string[] = [];
  const result = boundedHtmlToMarkdown(html, warnings).text;
  expect(result).toContain("## Contents");
  expect(result).toContain("[TAILX](/tail)");
  expect(result.match(/^Paragraph$/gm)).toHaveLength(4900);
  expect(warnings).toEqual([]);
});

it("still charges literal code text toward the output limit", () => {
  const warnings: string[] = [];
  const html = "<pre><code>" + "x".repeat(600_000) + "</code></pre>";
  const result = boundedHtmlToMarkdown(html, warnings).text;
  expect(warnings).toContainEqual(expect.stringMatching(/output size.*showing plain text/i));
  expect(result.length).toBeLessThanOrEqual(384 * 1024);
});
