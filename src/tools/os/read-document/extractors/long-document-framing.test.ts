import JSZip from "jszip";
import { expect, it } from "vitest";
import { emlExtractor, mboxExtractor } from "./email-extractor.js";
import { epubExtractor } from "./epub-extractor.js";

const recipients = "To: " + Array.from({ length: 64 }, (_, n) =>
  "recipient" + n + "@example.test").join(", ") + "\r\n";
const part = (body: string) => "--parts\r\nContent-Type: text/plain\r\n\r\n" + body + "\r\n";
const compose = (items: string[], header = "") => Buffer.from(header +
  'Content-Type: multipart/mixed; boundary="parts"\r\n\r\n' + items.join("") + "--parts--");
const wrapped = (message: string) => "--parts\r\nContent-Type: message/rfc822\r\n\r\n" + message + "\r\n";
const bodies = Array.from({ length: 20 }, (_, n) => part("BODY-" + (n + 1) + "-TAIL"));
const envelope = "From sender@example.test Fri Nov 27 00:00:00 2026\n";

async function book(title: string, body: string) {
  const file = new JSZip();
  file.file("book.opf", '<package><metadata><title>' + title + '</title></metadata><manifest>' +
    '<item id="c" href="chapter.xhtml"/></manifest><spine><itemref idref="c"/></spine></package>');
  file.file("chapter.xhtml", "<p>" + body + "</p>");
  return file.generateAsync({ type: "nodebuffer" });
}

it.each([1000, 1600])("keeps the same EML part when recipients exhaust %i bytes", async (maxBytes) => {
  const options = { data: compose(bodies, recipients), sourcePath: "fixture.eml", maxBytes };
  expect(Buffer.byteLength(recipients)).toBeGreaterThan(1600);
  const result = await emlExtractor(options);
  expect(result.text).not.toContain("BODY-1-TAIL");
  expect(result.warnings).toContainEqual(expect.stringMatching(/headers.*maxBytes.*pagesFrom=1/i));
  expect((await emlExtractor({ ...options, maxBytes: 2500, pagesFrom: 1 })).text).toContain("BODY-1-TAIL");
});

it("defers the same forwarded body when its headers consume the EML window", async () => {
  const data = compose([wrapped(recipients + "Content-Type: text/plain\r\n\r\nForwarded body"), ...bodies]);
  const options = { data, sourcePath: "fixture.eml", maxBytes: 1000 };
  const result = await emlExtractor(options);
  expect(result.warnings).toContainEqual(expect.stringMatching(/headers.*maxBytes.*pagesFrom=1/i));
  expect((await emlExtractor({ ...options, maxBytes: 2500, pagesFrom: 1 })).text).toContain("Forwarded body");
});

it("keeps the same EPUB chapter when its title consumes the window", async () => {
  const data = await book("Title " + "x".repeat(1600), "Chapter body");
  const options = { data, sourcePath: "fixture.epub", maxBytes: 1000 };
  const result = await epubExtractor(options);
  expect(result.pagesExtracted).toEqual([]);
  expect(result.warnings).toContainEqual(expect.stringMatching(/title.*maxBytes.*pagesFrom=1/i));
  expect((await epubExtractor({ ...options, maxBytes: 2500, pagesFrom: 1 })).text).toContain("Chapter body");
});

it("keeps the same MBOX message when its headers consume the window", async () => {
  const options = {
    data: Buffer.from(envelope + recipients + "Content-Type: text/plain\r\n\r\nFirst message"),
    sourcePath: "fixture.mbox",
    maxBytes: 1000,
  };
  const result = await mboxExtractor(options);
  expect(result.pagesExtracted).toEqual([]);
  expect(result.warnings).toContainEqual(expect.stringMatching(/headers.*maxBytes.*pagesFrom=1/i));
  expect((await mboxExtractor({ ...options, maxBytes: 2500, pagesFrom: 1 })).text).toContain("First message");
});
