import { performance } from "node:perf_hooks";
import JSZip from "jszip";
import { expect, it } from "vitest";
import { emlExtractor, mboxExtractor } from "./email-extractor.js";
import { epubExtractor } from "./epub-extractor.js";
import { FragmentBudget } from "./fragment-budget.js";
import { boundedHtmlToMarkdown } from "./html-markdown.js";

const tooManyNodes = "<p>Line</p>".repeat(15_100) + "<p>Tail</p>";
const deep = "<div>".repeat(2100) + "Deep body" + "</div>".repeat(2100);
const tooMuchText = "<p>" + "x".repeat(800_000) + "</p>";

it.each([tooManyNodes, deep, tooMuchText].map((html, n) => [n, html] as const))(
  "charges failed preparation path %i",
  (_n, html) => {
    const budget = new FragmentBudget(1);
    const warnings: string[] = [];
    for (let n = 0; n < 8; n++) boundedHtmlToMarkdown(html, warnings, false, budget);
    expect(budget.canFormat).toBe(false);
  },
);

it.each([undefined, 12 * 1024 * 1024])(
  "shares charged preparation across EML, MBOX and EPUB within three seconds (%s)",
  async (maxBytes) => {
    const variants = Array.from({ length: 14 }, (_, n) => n % 4 === 3 ? deep : tooManyNodes);
    const content = "Content-Type: text/html\r\n\r\n";
    const eml = 'Content-Type: multipart/mixed; boundary="fixture"\r\n\r\n' +
      variants.map((part) => "--fixture\r\n" + content + part + "\r\n").join("") + "--fixture--";
    const mbox = variants.map((part) =>
      "From sender@example.test Fri Nov 27 00:00:00 2026\n" + content + part).join("\n\n");
    const zip = new JSZip();
    zip.file("book.opf", '<package><manifest><item id="a" href="a.xhtml"/><item id="b" href="b.xhtml"/></manifest><spine>' +
      variants.map((part) => '<itemref idref="' + (part === deep ? "b" : "a") + '"/>').join("") +
      "</spine></package>");
    zip.file("a.xhtml", tooManyNodes);
    zip.file("b.xhtml", deep);
    const epub = await zip.generateAsync({ type: "nodebuffer" });
    const started = performance.now();
    for (const [extract, data, sourcePath] of [
      [emlExtractor, Buffer.from(eml), "fixture.eml"],
      [mboxExtractor, Buffer.from(mbox), "fixture.mbox"],
      [epubExtractor, epub, "fixture.epub"],
    ] as const) {
      const result = await extract({ data, sourcePath, maxBytes });
      expect(result.warnings.some((warning) => warning.includes("formatting budget exhausted"))).toBe(true);
    }
    expect(performance.now() - started).toBeLessThan(3000);
  },
);

it("keeps links across repeated paragraph starts with deeply nested inline wrappers", () => {
  const html = "<p>" + "<b>".repeat(100) + "<a href='/first'>First</a>" +
    "<p><span><a href='/next'>Next</a>".repeat(300);
  const result = boundedHtmlToMarkdown(html, []).text;
  expect(result.match(/\[Next\]\(\/next\)/g)).toHaveLength(300);
});
