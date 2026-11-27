import { performance } from "node:perf_hooks";
import JSZip from "jszip";
import { expect, it } from "vitest";
import { emlExtractor, mboxExtractor } from "./email-extractor.js";
import { epubExtractor } from "./epub-extractor.js";
import { boundedHtmlToMarkdown } from "./html-markdown.js";

it.each([
  ["paragraph", "<p>Ordinary document entry.</p>"],
  ["break", "Ordinary document entry.<br>"],
] as const)("bounds a standalone document with wide %s joins", (_name, row) => {
  const body = row.repeat(13_000) + "<p>TAILX</p>";
  const warnings: string[] = [];
  const start = performance.now();
  const result = boundedHtmlToMarkdown(body, warnings);
  expect(performance.now() - start).toBeLessThan(3000);
  expect(result.text.endsWith("TAILX")).toBe(true);
  expect(warnings).toContainEqual(expect.stringMatching(/sibling.*plain text/i));
});

it.each([
  ["eml", emlExtractor], ["mbox", mboxExtractor], ["epub", epubExtractor],
] as const)("bounds wide joins across twenty %s fragments at standard and elevated limits", async (format, extract) => {
  const paragraphs = "<p><b>Ordinary entry text</b></p>".repeat(9000);
  const breaks = "<p>" + ("Ordinary entry text<br>").repeat(9500) + "</p>";
  const contents = Array.from({ length: 20 }, (_, n) => (n % 2 ? breaks : paragraphs) + "<p>TAIL-" + n + "X</p>");
  const message = (value: string) => "Content-Type: text/html\r\n\r\n" + value;
  let data: Buffer;
  if (format === "epub") {
    const zip = new JSZip();
    const ids = contents.map((content, n) => {
      const id = "c" + n;
      zip.file(id + ".xhtml", content);
      return id;
    });
    zip.file("book.opf", "<package><manifest>" +
      ids.map((id) => '<item id="' + id + '" href="' + id + '.xhtml"/>').join("") +
      "</manifest><spine>" + ids.map((id) => '<itemref idref="' + id + '"/>').join("") +
      "</spine></package>");
    data = await zip.generateAsync({ type: "nodebuffer" });
  } else {
    data = Buffer.from(format === "eml" ?
      'Content-Type: multipart/mixed; boundary="parts"\r\n\r\n' +
      contents.map((part) => "--parts\r\n" + message(part) + "\r\n").join("") + "--parts--" :
      contents.map((part) => "From sender@example.test Fri Nov 27 00:00:00 2026\n" + message(part)).join("\n\n"));
  }
  for (const maxBytes of [undefined, 12 * 1024 * 1024]) {
    const start = performance.now();
    const result = await extract({ data, sourcePath: "fixture." + format, maxBytes });
    expect(performance.now() - start).toBeLessThan(3000);
    expect(result.text.endsWith("TAIL-19X")).toBe(true);
    expect(result.warnings).toContainEqual(expect.stringMatching(/formatting budget exhausted/i));
  }
}, 30_000);
