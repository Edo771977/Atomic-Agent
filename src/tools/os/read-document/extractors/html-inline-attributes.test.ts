import { describe, expect, it } from "vitest";

import { htmlExtractor } from "./html-extractor.js";

const run = (html: string | Buffer) =>
  htmlExtractor({
    data: typeof html === "string" ? Buffer.from(html, "utf8") : html,
    sourcePath: "page.html",
  });

describe("HTML inline attributes", () => {
  it("retains trailing link text after large attributes and replaces data URLs", async () => {
    const decoration = "x".repeat(420 * 1024);
    const result = await run(`<p style="${decoration}" class="mso" mso-padding-alt="${decoration}">Visible intro</p>` +
      `<img src="data:image/png;base64,${decoration}" alt="Logo"><a href="https://example.test">` +
      `Final link text</a><a href="https://example.test/${"long".repeat(600)}">Long URL label</a>` +
      `<a href="da&#9;ta:text/plain,fixture">Data URL label</a><p>Final paragraph</p>`);
    expect(result.text).toContain("Logo");
    expect(result.text).toContain("Long URL label");
    expect(result.text).toContain("Data URL label");
    expect(result.text).not.toContain("text/plain");
    expect(result.text).not.toContain("longlong");
    expect(result.text).toContain("[Final link text](https://example.test)");
    expect(result.text).toContain("Final paragraph");
    expect(result.text).not.toContain("data:image");
    expect(result.warnings).toEqual([]);
  });

});
