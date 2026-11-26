import { performance } from "node:perf_hooks";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { emlExtractor } from "./email-extractor.js";
import { epubExtractor } from "./epub-extractor.js";
import { htmlExtractor } from "./html-extractor.js";
import { boundedHtmlToMarkdown } from "./html-markdown.js";

describe("whitespace in HTML-to-Markdown conversion", () => {
  it.each([
    ["preformatted spaces", " ".repeat(400_000)],
    ["nonbreaking space entities", "&nbsp;".repeat(65_000)],
    ["ideographic spaces", "\u3000".repeat(133_000)],
  ])("caps runs of %s and preserves the tail", (_label, spaces) => {
    const warnings: string[] = [];
    const start = performance.now();
    const result = boundedHtmlToMarkdown(
      "<h2>First</h2><pre>Start" + spaces + "X" + spaces.slice(0, 600) + "TAILX</pre>",
      warnings,
    ).text;
    expect(performance.now() - start).toBeLessThan(2000);
    expect(result).toContain("## First");
    expect(result).toMatch(/Start\s{1,256}X\s{1,256}TAILX/);
    expect(result.length).toBeLessThan(600);
  });

  it("caps consecutive breaks before they consume the formatting budget", () => {
    const warnings: string[] = [];
    const start = performance.now();
    const result = boundedHtmlToMarkdown(
      "<p>First" + "<br>".repeat(29_990) + "</p>" +
        "<p>Ordinary paragraph</p>".repeat(20) +
        '<h2>TAILX</h2><p><a href="https://example.test/">Link</a></p>',
      warnings,
    ).text;
    expect(performance.now() - start).toBeLessThan(2000);
    expect(result).toContain("## TAILX");
    expect(result).toContain("[Link](https://example.test/)");
    expect(result.length).toBeLessThan(1400);
  });

  it("caps preformatted runs in HTML, EML and EPUB", async () => {
    const html = "<pre>Start" + " ".repeat(1600) + "TAILX</pre>";
    const zip = new JSZip();
    zip.file("book.opf", '<package><manifest><item id="c" href="chapter.xhtml"/></manifest><spine><itemref idref="c"/></spine></package>');
    zip.file("chapter.xhtml", html);
    const results = await Promise.all([
      htmlExtractor({ data: Buffer.from(html), sourcePath: "fixture.html" }),
      emlExtractor({
        data: Buffer.from("Content-Type: text/html\r\n\r\n" + html),
        sourcePath: "fixture.eml",
      }),
      epubExtractor({ data: await zip.generateAsync({ type: "nodebuffer" }), sourcePath: "fixture.epub" }),
    ]);
    for (const result of results) expect(result.text).toMatch(/Start {1,256}TAILX/);
  });
});
