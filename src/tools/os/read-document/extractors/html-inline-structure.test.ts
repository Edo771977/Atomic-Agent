import { describe, expect, it } from "vitest";
import { boundedHtmlToMarkdown } from "./html-markdown.js";

describe("HTML inline structure", () => {
  it("keeps 300 headings and links below unclosed named anchors", () => {
    const html = Array.from(
      { length: 300 },
      (_, n) => '<a name="n' + n + '"><h2>Section ' + n + '</h2><p><a href="/ref">Reference</a></p>',
    ).join("");
    const warnings: string[] = [];
    const result = boundedHtmlToMarkdown(html, warnings).text;
    expect(result.match(/^## Section \d+$/gm)).toHaveLength(300);
    expect(result.match(/\[Reference\]\(\/ref\)/g)).toHaveLength(300);
    expect(warnings).toEqual([]);
  });

  it("keeps 300 links below unclosed spans", () => {
    const html = '<span><a href="/ref">Reference</a>'.repeat(300);
    const warnings: string[] = [];
    const result = boundedHtmlToMarkdown(html, warnings).text;
    expect(result.match(/\[Reference\]\(\/ref\)/g)).toHaveLength(300);
    expect(warnings).toEqual([]);
  });

  it("closes a link before a new anchor, even through inline markup", () => {
    const result = boundedHtmlToMarkdown(
      '<p><a href="/one">First<em> emphasis<a href="/two">Second</a></em></a></p>',
      [],
    ).text;
    expect(result).toBe("[First _emphasis_](/one)[Second](/two)");
  });
});
