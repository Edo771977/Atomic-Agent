import JSZip from "jszip";
import { expect, it } from "vitest";
import { emlExtractor, mboxExtractor } from "./email-extractor.js";
import { epubExtractor } from "./epub-extractor.js";
import { FragmentOutput } from "./fragment-budget.js";

const recipients = "To: " + "reader@example.test, ".repeat(80) + "\r\n";
const identity = "From: origin@example.test\r\nSubject: An identifiable subject\r\n";
const text = (body: string) => "Content-Type: text/plain\r\n\r\n" + body;
const envelope = "From sender@example.test Fri Nov 27 00:00:00 2026\n";

function body(tag: string, length: number) {
  return tag + "-" + "x".repeat(length - tag.length - 5) + "-END";
}

function mixed(parts: string[], header = ""): Buffer {
  return Buffer.from(header + 'Content-Type: multipart/mixed; boundary="fixture"\r\n\r\n' +
    parts.map((part) => "--fixture\r\n" + part + "\r\n").join("") + "--fixture--");
}

const forwarded = (inner: string) => "Content-Type: message/rfc822\r\n\r\n" + inner;

function expectsFramingNotice(result: { warnings: string[]; truncated?: boolean }) {
  expect(result.truncated).toBe(true);
  expect(result.warnings).toContainEqual(expect.stringMatching(/(?:headers|title).*(?:abbreviated|omitted).*maxBytes/i));
}

it("does not compact a later item whose full prefix would exceed the window", () => {
  const window = new FragmentOutput(100);
  expect(window.appendItem("", "First").status).toBe("complete");
  expect(window.appendItem("Header ".repeat(20), "Second", false, "").status).toBe("deferred");
});

it("keeps a complete first EML body with a compact From and Subject", async () => {
  const content = body("OUTER", 960);
  const data = Buffer.from(identity + recipients + text(content));
  const result = await emlExtractor({ data, sourcePath: "single.eml", maxBytes: 1000 });
  expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(1000);
  expect(result.text).toContain(content);
  expect(result.text).toMatch(/^From: .*Subject: .*$/m);
  expectsFramingNotice(result);
});

it("keeps the marker, compact identity and full body of a forwarded EML", async () => {
  const content = body("INNER", 950);
  const data = mixed([forwarded(identity + recipients + text(content))]);
  const result = await emlExtractor({ data, sourcePath: "forwarded.eml", maxBytes: 1000 });
  expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(1000);
  expect(result.text.split("\n")).toContain("--- attached message ---");
  expect(result.text).toMatch(/^From: .*Subject: .*$/m);
  expect(result.text).toContain(content);
  expectsFramingNotice(result);
});

it.each(["outer", "nested"] as const)("retains 20 of 20 complete EML bodies with long %s headers", async (location) => {
  const expected = Array.from({ length: 20 }, (_, n) => body("BODY-" + (n + 1), 130));
  const parts = expected.map((value) =>
    location === "nested" ? forwarded(identity + recipients + text(value)) : text(value));
  const data = mixed(parts, location === "outer" ? identity + recipients : "");
  const collected: string[] = [];
  let pagesFrom: number | undefined;
  for (let call = 0; call < expected.length; call++) {
    const result = await emlExtractor({ data, sourcePath: "replies.eml", maxBytes: 1000, pagesFrom });
    const visible = result.text.split("\n").filter((line) => line.startsWith("BODY-"));
    collected.push(...visible);
    expect(visible.length).toBeGreaterThan(0);
    if (location === "nested") {
      expect(result.text.split("\n").filter((line) => line === "--- attached message ---")).toHaveLength(visible.length);
    }
    const next = result.warnings.join("\n").match(/pagesFrom=(\d+)/)?.[1];
    if (!next) break;
    expect(Number(next)).toBeGreaterThan(pagesFrom ?? 1);
    pagesFrom = Number(next);
  }
  expect(collected).toEqual(expected);
});

it("shows CH1END and explicitly reports omission of a 330-byte EPUB title", async () => {
  const zip = new JSZip();
  zip.file("book.opf", "<package><metadata><title>" + "t".repeat(330) +
    '</title></metadata><manifest><item id="c" href="chapter.xhtml"/></manifest><spine>' +
    '<itemref idref="c"/></spine></package>');
  zip.file("chapter.xhtml", "<p>" + body("CH1", 815).replace("-END", "CH1END") + "</p>");
  const data = await zip.generateAsync({ type: "nodebuffer" });
  const result = await epubExtractor({ data, sourcePath: "title.epub", maxBytes: 1000, pagesFrom: 1 });
  expect(result.text).toContain("--- chapter 1 ---");
  expect(result.text).toContain("CH1END");
  expect(result.pagesExtracted).toEqual([1]);
  expectsFramingNotice(result);
});

it("retains the MBOX marker and compact identity when opening its second message", async () => {
  const content = body("MESSAGE-TWO", 960);
  const data = Buffer.from(envelope + text("First message") + "\n\n" +
    envelope + identity + recipients + text(content));
  const result = await mboxExtractor({ data, sourcePath: "messages.mbox", maxBytes: 1000, pagesFrom: 2 });
  expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(1000);
  expect(result.text.split("\n")).toContain("--- message 2 ---");
  expect(result.text).toMatch(/^From: .*Subject: .*$/m);
  expect(result.text).toContain(content);
  expect(result.pagesExtracted).toEqual([2]);
  expectsFramingNotice(result);
});
