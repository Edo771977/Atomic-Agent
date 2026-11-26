import { performance } from "node:perf_hooks";
import JSZip from "jszip";
import { expect, it } from "vitest";
import { emlExtractor } from "./email-extractor.js";
import { epubExtractor } from "./epub-extractor.js";

const paragraph = (chars: number) => "Prose " + "x".repeat(chars - 6);

async function book(chapters: number, prose: string) {
  const zip = new JSZip();
  zip.file("book.opf", '<package><manifest><item id="c" href="chapter.xhtml"/></manifest><spine>' +
    '<itemref idref="c"/>'.repeat(chapters) + '</spine></package>');
  zip.file("chapter.xhtml", "<h2>Chapter</h2><p>" + prose + "</p>");
  return zip.generateAsync({ type: "nodebuffer" });
}

function mail(parts: string[]) {
  return Buffer.from('Content-Type: multipart/mixed; boundary="fixture"\r\n\r\n' +
    parts.map((part) => "--fixture\r\nContent-Type: text/html\r\n\r\n" + part + "\r\n").join("") +
    "--fixture--\r\n");
}

it.each([[50, 40_000], [50, 60_000], [30, 120_000], [50, 183_000, 10 * 1024 * 1024]])(
  "keeps all %i ordinary EPUB chapters with %i characters of prose each", async (chapters, chars, maxBytes?: number) => {
    const prose = paragraph(chars);
    const result = await epubExtractor({ data: await book(chapters, prose), sourcePath: "book.epub", maxBytes });
    expect(result.pagesExtracted).toHaveLength(chapters);
    expect(result.text === Array.from({ length: chapters }, (_, n) =>
      "--- chapter " + (n + 1) + " ---\n## Chapter\n\n" + prose).join("\n\n")).toBe(true);
    expect(result.warnings).toEqual([]);
  },
);

it("keeps all ten ordinary formatted MIME parts", async () => {
  const prose = paragraph(183_000);
  const data = mail(Array.from({ length: 10 }, (_, n) => "<h2>Section " + n + "</h2><p>" + prose + "</p>"));
  const result = await emlExtractor({ data, sourcePath: "multi.eml" });
  expect(result.text === Array.from({ length: 10 }, (_, n) =>
    "## Section " + n + "\n\n" + prose).join("\n\n")).toBe(true);
  expect(result.warnings).toEqual([]);
});

it("degrades later DOM-heavy fragments to text and keeps the tail in under three seconds", async () => {
  const list = "<ul>" + "<li><a href='/ref'>List item</a></li>".repeat(400) + "</ul>";
  const data = mail(Array.from({ length: 128 }, (_, n) => "<h2>Section " + n + "</h2>" + list + "<p>TAIL" + n + "X</p>"));
  const start = performance.now();
  const result = await emlExtractor({ data, sourcePath: "multi.eml" });
  expect(result.text.includes("## Section 0")).toBe(true);
  expect(result.text.includes("## Section 127")).toBe(false);
  expect(result.text.endsWith("TAIL127X")).toBe(true);
  expect(result.warnings).toContainEqual(expect.stringMatching(/formatting budget.*plain text/i));
  expect(performance.now() - start).toBeLessThan(3000);
});
