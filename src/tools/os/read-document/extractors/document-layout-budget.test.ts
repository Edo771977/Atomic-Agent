import { performance } from "node:perf_hooks";
import JSZip from "jszip";
import { expect, it } from "vitest";
import { emlExtractor } from "./email-extractor.js";
import { epubExtractor } from "./epub-extractor.js";

function mail(parts: string[]) {
  return Buffer.from('Content-Type: multipart/mixed; boundary="fixture"\r\n\r\n' +
    parts.map((part) => "--fixture\r\nContent-Type: text/html\r\n\r\n" + part + "\r\n").join("") +
    "--fixture--");
}

it("keeps link formatting in a ten-part wiki within an explicit output allowance", async () => {
  const parts = Array.from({ length: 10 }, (_, n) =>
    "<h2>Section " + n + "</h2><p>" + "<a href='/entry'>An entry</a> ".repeat(3500) +
    "<a href='/end'>End " + n + "</a></p>");
  const started = performance.now();
  const result = await emlExtractor({ data: mail(parts), sourcePath: "wiki.eml", maxBytes: 8 * 1024 * 1024 });
  expect(result.text.match(/\[An entry\]\(\/entry\)/g)).toHaveLength(35_000);
  expect(result.text).toContain("[End 9](/end)");
  expect(performance.now() - started).toBeLessThan(3000);
});

it("retains Outlook-style tables across fifty ordinary EPUB chapters", async () => {
  const zip = new JSZip();
  const row = '<tr><td><p class="MsoNormal"><span>Item</span></p></td><td><p>Notes</p></td></tr>';
  const chapter = "<html><head><style>.MsoNormal{color:black}</style></head><body>" +
    "<table><tr><th>Item</th><th>Notes</th></tr>" + row.repeat(60) + "</table></body></html>";
  zip.file("chapter.xhtml", chapter);
  zip.file("book.opf", '<package><manifest><item id="c" href="chapter.xhtml"/></manifest><spine>' +
    '<itemref idref="c"/>'.repeat(50) + "</spine></package>");
  const data = await zip.generateAsync({ type: "nodebuffer" });
  const result = await epubExtractor({ data, sourcePath: "notes.epub" });
  expect(result.pagesExtracted).toHaveLength(50);
  expect(result.text.match(/\| --- \| --- \|/g)).toHaveLength(50);
});

it("can read ten styled Outlook HTML parts totaling 22.6 MB at the default output limit", async () => {
  const css = "/*" + "x".repeat(2_260_000) + "*/";
  const parts = Array.from({ length: 10 }, (_, n) =>
    "<html><head><style>" + css + "</style></head><body><table><tr><td>A</td><td>" +
    n + "</td></tr></table></body></html>");
  const started = performance.now();
  const result = await emlExtractor({ data: mail(parts), sourcePath: "outlook.eml" });
  expect(result.text.match(/\| --- \| --- \|/g)).toHaveLength(10);
  expect(result.warnings).toEqual([]);
  expect(performance.now() - started).toBeLessThan(3000);
});
