import { describe, expect, it } from "vitest";

import { htmlExtractor } from "./html-extractor.js";

const run = (html: string | Buffer) =>
  htmlExtractor({
    data: typeof html === "string" ? Buffer.from(html, "utf8") : html,
    sourcePath: "page.html",
  });

describe("HTML format budgets", () => {
  it("counts the outer table cells independently of nested cells and text pipes", async () => {
    const inner = "<table><tr><td>Nested | cell</td><td>Second</td></tr></table>";
    const result = await run(`<table><tr><td>Outer ${inner}</td><td>Last</td></tr></table>`);
    expect(result.text.match(/\| --- /g)).toHaveLength(2);
    expect(result.text).toContain("Nested");
    expect(result.text).toContain("Last");
  });

  it("bounds formatting for a wide table and for tables nested beyond 64 levels", async () => {
    const wide = "<table><tr>" + "<td>Cell</td>".repeat(66) + "</tr></table>";
    const deep = "<table><tr><td>".repeat(65) + "Nested cell" + "</td></tr></table>".repeat(65);
    for (const [html, warning] of [[wide, /table width/i], [deep, /table nesting/i]] as const) {
      const started = performance.now();
      const result = await run(html + "<p>After tables</p>");
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(result.text).toContain("After tables");
      expect(result.text.length).toBeLessThan(2_000);
      expect(result.warnings.join("\n")).toMatch(warning);
    }
  });

  it("bounds Markdown lists, quote nesting, and generated output", async () => {
    const fixtures = [
      "<ul><li>".repeat(140) + "List entry" + "</li></ul>".repeat(140),
      "<blockquote>".repeat(40) + "A quotation" + "</blockquote>".repeat(40),
      "<p>" + "*".repeat(300_000) + "</p>",
      "<p>x</p>".repeat(16_000),
    ];
    for (const html of fixtures) {
      const started = performance.now();
      const result = await run(html + "<p>Tail marker</p>");
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(result.text.length).toBeLessThanOrEqual(576 * 1024);
      expect(result.text).toContain("Tail marker");
      expect(result.warnings).not.toEqual([]);
    }
  });
});
