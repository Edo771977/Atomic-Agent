import { expect, it } from "vitest";
import { emlExtractor } from "./email-extractor.js";

function textPart(text: string): string {
  return "Content-Type: text/plain\r\n\r\n" + text;
}

function attachment(name: string, mime: string, body: string): string {
  return "Content-Type: " + mime + "\r\nContent-Disposition: attachment; filename=" + name + "\r\n\r\n" + body;
}

async function email(parts: string[]) {
  const raw = 'Content-Type: multipart/mixed; boundary="fixture"\r\n\r\n' +
    parts.map((part) => "--fixture\r\n" + part + "\r\n").join("") + "--fixture--\r\n";
  return emlExtractor({ data: Buffer.from(raw), sourcePath: "mail.eml" });
}

it("keeps six captions and all photo attachments", async () => {
  const jpeg = "x".repeat(3 * 1024 * 1024);
  const parts = Array.from({ length: 6 }, (_, n) =>
    [attachment("photo-" + n + ".jpg", "image/jpeg", jpeg), textPart("Caption " + n)]).flat();
  const result = await email([...parts, textPart("Signature")]);
  for (let n = 0; n < 6; n++) {
    expect(result.text).toContain("Caption " + n);
    expect(result.text).toContain("photo-" + n + ".jpg (image/jpeg, 3.0 MB)");
  }
  expect(result.text).toContain("Signature");
  expect(result.warnings).toEqual([]);
});

it("keeps the signature after three large PDFs", async () => {
  const pdf = "x".repeat(6 * 1024 * 1024);
  const result = await email([
    ...Array.from({ length: 3 }, (_, n) => attachment("report-" + n + ".pdf", "application/pdf", pdf)),
    textPart("Signature"),
  ]);
  expect(result.text.match(/\.pdf \(application\/pdf, 6\.0 MB\)/g)).toHaveLength(3);
  expect(result.text).toContain("Signature");
  expect(result.warnings).toEqual([]);
});

it("lists all 140 attachments and keeps the following message body", async () => {
  const result = await email([
    ...Array.from({ length: 140 }, (_, n) => attachment("note-" + n + ".txt", "text/plain", "file")),
    textPart("Message body"),
  ]);
  expect(result.text.match(/^- note-\d+\.txt \(text\/plain, 4 B\)$/gm)).toHaveLength(140);
  expect(result.text).toContain("Message body");
  expect(result.warnings).toEqual([]);
});

it("keeps listing attachments after the text budget is exhausted", async () => {
  const result = await email([
    ...Array.from({ length: 128 }, () => textPart("Earlier text")),
    textPart("Skipped body"),
    attachment("after.pdf", "application/pdf", "file"),
  ]);
  expect(result.text).not.toContain("Skipped body");
  expect(result.text).toContain("after.pdf (application/pdf, 4 B)");
  expect(result.warnings).toContainEqual(expect.stringMatching(/MIME.*budget.*skipped/i));
});
