import { describe, expect, it } from "vitest";

import { htmlExtractor } from "./html-extractor.js";

const run = (html: string | Buffer) =>
  htmlExtractor({
    data: typeof html === "string" ? Buffer.from(html, "utf8") : html,
    sourcePath: "page.html",
  });

describe("HTML table layout", () => {
  it("pads short rows and column spans to the separator width", async () => {
    const result = await run('<table><tr><th colspan="2">Name</th></tr><tr><td>Ada</td><td>Notes</td></tr>' +
      '<tr><td>Short</td></tr><tr><td>Empty</td><td></td></tr></table>');
    expect(result.text).toBe("| Name |  |\n| --- | --- |\n| Ada | Notes |\n| Short |  |\n| Empty |  |");
  });

  it("flattens a 5000-column table without affecting a following heading and link", async () => {
    const started = performance.now();
    const result = await run("<table><tr>" + "<td>Cell</td>".repeat(5000) + "</tr></table>" +
      '<h2>After the table</h2><a href="https://example.test/tail">Tail</a>');
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(result.warnings).toContainEqual(expect.stringMatching(/table width.*64 columns/i));
    expect(result.warnings.join("\n")).not.toContain("Showing plain text");
    expect(result.text).toContain("## After the table");
    expect(result.text).toContain("[Tail](https://example.test/tail)");
    expect(result.text).not.toContain("| ---");
  });
});
