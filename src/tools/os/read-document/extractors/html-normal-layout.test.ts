import { describe, expect, it } from "vitest";
import { htmlExtractor } from "./html-extractor.js";

async function extract(html: string) {
  const start = performance.now();
  const result = await htmlExtractor({ data: Buffer.from(html), sourcePath: "fixture.html" });
  expect(performance.now() - start).toBeLessThan(2_000);
  expect(result.warnings.join("\n")).not.toContain("Showing plain text");
  return result;
}

describe("normal HTML layout", () => {
  it("keeps 30 links in a newsletter with six nested layout tables", async () => {
    const links = Array.from({ length: 30 }, (_, i) => `<a href="https://example.test/item/${i}">Item ${i}</a>`).join(" ");
    const result = await extract("<table><tr><td>".repeat(6) + links + "</td></tr></table>".repeat(6));
    expect(result.text.match(/https:\/\/example\.test\/item\//g)).toHaveLength(30);
    expect(result.text).toContain("| --- |");
  });

  it("retains the markers of a twelve-reply chain", async () => {
    const result = await extract("<blockquote>".repeat(12) + "<p>Oldest reply</p>" + "</blockquote>".repeat(12));
    expect(result.text).toContain("> ".repeat(12) + "Oldest reply");
  });

  it("keeps a 600-row table with five columns as a grid", async () => {
    const row = "<tr><td>First</td><td>Second</td><td>Third</td><td>Fourth</td><td>Fifth</td></tr>";
    const result = await extract("<table>\n" + (row + "\n").repeat(600) + "</table>");
    expect(result.text).toContain("| --- | --- | --- | --- | --- |");
    expect(result.text.match(/\| First \| Second \| Third \| Fourth \| Fifth \|/g)).toHaveLength(600);
  });

  it("keeps 300 headings and all 7500 links in an indented wiki", async () => {
    const sections = Array.from({ length: 300 }, (_, section) => {
      const links = Array.from({ length: 25 }, (_, link) =>
        `    <a href="https://example.test/wiki/${section}/${link}">Reference</a>\n`).join("");
      return `  <h2>Section ${section}</h2>\n  <p>\n${links}  </p>\n`;
    }).join("");
    const result = await extract(sections);
    expect(result.text.match(/^## Section /gm)).toHaveLength(300);
    expect(result.text.match(/https:\/\/example\.test\/wiki\//g)).toHaveLength(7500);
  });

  it("flattens only excess depth and preserves surrounding Markdown", async () => {
    const result = await extract("<h2>Introduction</h2>" + "<font size=2>Line<br>".repeat(1200) +
      '<a href="https://example.test/end">Final link</a>');
    expect(result.text).toContain("## Introduction");
    expect(result.text).toContain("Final link");
    expect(result.warnings.join("\n")).toMatch(/depth.*flattened/i);
  });
  it("charges decoded text rather than the length of escaped HTML", async () => {
    const result = await extract("<h2>Markup count</h2><p>" + "&lt;".repeat(380_000) + "</p>");
    expect(result.text).toContain("## Markup count");
    expect(result.text.match(/</g)).toHaveLength(380_000);
    expect(result.warnings).toEqual([]);
  });
});
