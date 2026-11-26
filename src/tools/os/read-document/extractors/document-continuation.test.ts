import JSZip from "jszip";
import { expect, it } from "vitest";
import { emlExtractor, mboxExtractor } from "./email-extractor.js";
import { epubExtractor } from "./epub-extractor.js";

const mime = (parts: string[], header = "") => Buffer.from(header +
  'Content-Type: multipart/mixed; boundary="fixture"\r\n\r\n' +
  parts.map((part) => "--fixture\r\nContent-Type: text/plain\r\n\r\n" + part + "\r\n").join("") +
  "--fixture--");

const mailbox = (parts: string[]) => Buffer.from(parts.map((part, n) =>
  "From sender@example.test Fri Nov 27 00:00:00 2026\nSubject: Note " + (n + 1) +
  "\nContent-Type: text/plain\n\n" + part).join("\n\n"));

async function book(parts: string[], title = "") {
  const zip = new JSZip();
  const ids = parts.map((part, n) => {
    const id = "c" + n;
    zip.file(id + ".xhtml", "<p>" + part + "</p>");
    return id;
  });
  zip.file("book.opf", "<package><metadata><title>" + title + "</title></metadata><manifest>" +
    ids.map((id) => '<item id="' + id + '" href="' + id + '.xhtml"/>').join("") +
    "</manifest><spine>" + ids.map((id) => '<itemref idref="' + id + '"/>').join("") +
    "</spine></package>");
  return zip.generateAsync({ type: "nodebuffer" });
}

function cursor(warnings: string[]) {
  const warning = warnings.find((value) => value.includes("pagesFrom="));
  return Number(warning?.match(/pagesFrom=(\d+)/)?.[1]);
}

const samples = Array.from({ length: 200 }, (_, n) =>
  "ITEM-" + (n + 1) + "-COMPLETE \u00e8 con altro testo.");

it("resumes EML exactly after the last complete part within the displayed byte budget", async () => {
  const subject = "Subject: Long title " + "x".repeat(45) + "\r\n";
  const outer = mime(samples, subject).toString().replace("--fixture--",
    '--fixture\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="report.pdf"\r\n\r\nstub\r\n--fixture--');
  const input = { data: Buffer.from(outer), sourcePath: "fixture.eml", maxBytes: 300 };
  const all: string[] = [];
  for (let start = 1; start <= samples.length;) {
    const result = await emlExtractor({ ...input, pagesFrom: start });
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(300);
    const items = result.text.split("\n").filter((line) => line.startsWith("ITEM-"));
    expect(items.length).toBeGreaterThan(0);
    all.push(...items);
    const next = cursor(result.warnings);
    if (all.length === samples.length) break;
    expect(next).toBe(start + items.length);
    start = next;
  }
  expect(all).toEqual(samples);
});

it("does not spend a resumed EML window on headers from skipped forwarded parts", async () => {
  const message = 'Content-Type: multipart/mixed; boundary="fixture"\r\n\r\n' +
    samples.map((part, n) => "--fixture\r\nContent-Type: message/rfc822\r\n\r\nSubject: Forward " +
      (n + 1) + "\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n" + part + "\r\n").join("") +
    "--fixture--";
  const result = await emlExtractor({
    data: Buffer.from(message), sourcePath: "forwarded.eml", maxBytes: 300, pagesFrom: 198,
  });
  expect(result.text).not.toContain("Subject: Forward 1\n");
  expect(result.text.split("\n").filter((line) => line.startsWith("ITEM-"))).toEqual(samples.slice(197));
  expect(result.warnings).toEqual([]);
});

it("only advertises EPUB pages that fit alongside title and chapter markers", async () => {
  const input = { data: await book(samples, "Book title"), sourcePath: "fixture.epub", maxBytes: 300 };
  const all: number[] = [];
  for (let start = 1; start <= samples.length;) {
    const result = await epubExtractor({ ...input, pagesFrom: start });
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(300);
    const shown = result.text.split("\n").filter((line) => line.startsWith("ITEM-"));
    const pages = result.pagesExtracted ?? [];
    expect(shown).toEqual(pages.map((page) => samples[page - 1]));
    expect(pages.length).toBeGreaterThan(0);
    all.push(...pages);
    if (all.length === samples.length) break;
    const next = cursor(result.warnings);
    expect(next).toBe(start + pages.length);
    start = next;
  }
  expect(all).toEqual(Array.from({ length: 200 }, (_, n) => n + 1));
});

it("balances MBOX message headings and body text in the actual output", async () => {
  const input = { data: mailbox(samples.slice(0, 10)), sourcePath: "fixture.mbox", maxBytes: 300 };
  const result = await mboxExtractor(input);
  expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(300);
  expect(result.text.split("\n").filter((line) => line.startsWith("ITEM-"))).toEqual(
    result.pagesExtracted?.map((page) => samples[page - 1]),
  );
  expect(cursor(result.warnings)).toBe((result.pagesExtracted?.at(-1) ?? 0) + 1);
});

it.each(["eml", "mbox", "epub"] as const)(
  "reports a 6 MiB middle %s item as truncated and resumes at the following item",
  async (format) => {
    const parts = ["First body", "Large body " + "x".repeat(6 * 1024 * 1024), "Third body"];
    const [extract, data] = format === "eml" ? [emlExtractor, mime(parts)]
      : format === "mbox" ? [mboxExtractor, mailbox(parts)] : [epubExtractor, await book(parts)];
    const input = { data, sourcePath: "fixture." + format };
    const first = await extract(input);
    expect(first.text.includes("Large body")).toBe(true);
    expect(first.warnings.some((warning) => /(?:part|message|chapter) 2 (?:was |is )?truncated/i.test(warning))).toBe(true);
    expect(cursor(first.warnings)).toBe(3);
    const last = await extract({ ...input, pagesFrom: 3 });
    expect(last.text).toContain("Third body");
    expect(last.text).not.toContain("Large body");
  },
);

it("leaves a partially displayed EPUB chapter out of pagesExtracted", async () => {
  const result = await epubExtractor({
    data: await book(["Partial chapter " + "x".repeat(800)]),
    sourcePath: "fixture.epub",
    maxBytes: 300,
  });
  expect(result.text).toContain("Partial chapter");
  expect(result.truncated).toBe(true);
  expect(result.pagesExtracted).toEqual([]);
});

