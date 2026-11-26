import { expect, it } from "vitest";
import { boundedHtmlToMarkdown } from "./html-markdown.js";

it("keeps both rows of a two-column table when an anchor crosses the table", () => {
  const html = '<a href="/outer"><table><tr><th>One</th><th>Two</th></tr>' +
    '<tr><td><a href="/inner">Inside</a></td><td>Other</td></tr></table></a>';
  const result = boundedHtmlToMarkdown(html, []).text;
  expect(result).toContain("| One | Two |\n| --- | --- |\n| [Inside](/inner) | Other |");
});

it("keeps div boundaries and quotation formatting across overlapping anchors", () => {
  const html = '<a href="/outer"><div>Before <a href="/inside">Inside</a></div>' +
    '<blockquote>Quote <a href="/source">Source</a></blockquote></a><p>After</p>';
  const result = boundedHtmlToMarkdown(html, []).text;
  expect(result).toBe("Before [Inside](/inside)\n\n> Quote [Source](/source)\n\nAfter");
});

it("keeps an ordinary outer link around a block with no overlapping anchor", () => {
  const result = boundedHtmlToMarkdown('<a href="/card"><div>Linked card</div></a>', []).text;
  expect(result).toContain("Linked card");
  expect(result).toContain("](/card)");
});
