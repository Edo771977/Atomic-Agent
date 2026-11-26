import JSZip from "jszip";
import { expect, it } from "vitest";
import { emlExtractor, mboxExtractor } from "./email-extractor.js";
import { epubExtractor } from "./epub-extractor.js";

const paragraph = "A normal forty-character paragraph ends.";
const html = ("<p>" + paragraph + "</p>").repeat(15_000) + "<p>TAILX</p>";

const email = (body: string, type: string) =>
  "Subject: Large body\r\nContent-Type: " + type + "\r\n\r\n" + body;

it.each([705_000, 742_000, 768_000])("keeps a single large HTML email body around %i characters", async (size) => {
  const body = "<p>" + "a".repeat(Math.max(0, size - html.length)) + "</p>" + html;
  const result = await emlExtractor({ data: Buffer.from(email(body, "text/html")), sourcePath: "large.eml" });
  expect(result.text.includes(paragraph)).toBe(true);
  expect(result.text.endsWith("TAILX")).toBe(true);
});

it("keeps a 2 MiB plain-text email and its end", async () => {
  const body = "A log line\n".repeat(200_000) + "TAILX";
  const result = await emlExtractor({ data: Buffer.from(email(body, "text/plain")), sourcePath: "large.eml" });
  expect(result.text.length).toBeGreaterThan(2 * 1024 * 1024);
  expect(result.text.endsWith("TAILX")).toBe(true);
});

it("keeps a large plain alternative and tries HTML if plain text is unavailable", async () => {
  const alternative = (plain: string) =>
    email("--fixture\r\nContent-Type: text/plain\r\n\r\n" + plain +
      "\r\n--fixture\r\nContent-Type: text/html\r\n\r\n<h2>HTML alternative</h2>\r\n--fixture--",
    'multipart/alternative; boundary="fixture"');
  const large = "Log line\n".repeat(200_000) + "TAILX";
  const normal = await emlExtractor({ data: Buffer.from(alternative(large)), sourcePath: "alternative.eml" });
  expect(normal.text.endsWith("TAILX")).toBe(true);
  const empty = await emlExtractor({ data: Buffer.from(alternative("   ")), sourcePath: "alternative.eml" });
  expect(empty.text.endsWith("## HTML alternative")).toBe(true);
});

it("reads a large EPUB chapter when opening it via pagesFrom", async () => {
  const zip = new JSZip();
  zip.file("book.opf", '<package><manifest><item id="c" href="chapter.xhtml"/></manifest><spine><itemref idref="c"/><itemref idref="c"/></spine></package>');
  zip.file("chapter.xhtml", html);
  const data = await zip.generateAsync({ type: "nodebuffer" });
  const result = await epubExtractor({ data, sourcePath: "large.epub", pagesFrom: 2 });
  expect(result.pagesExtracted).toEqual([2]);
  expect(result.text.endsWith("TAILX")).toBe(true);
});

it("reads a large mbox body when opening its message via pagesFrom", async () => {
  const start = "From sender@example.test Mon Jan 1 00:00:00 2024\n";
  const data = Buffer.from(start + email("first", "text/plain") + "\n\n" + start + email(html, "text/html"));
  const result = await mboxExtractor({ data, sourcePath: "large.mbox", pagesFrom: 2 });
  expect(result.pagesExtracted).toEqual([2]);
  expect(result.text.endsWith("TAILX")).toBe(true);
});
