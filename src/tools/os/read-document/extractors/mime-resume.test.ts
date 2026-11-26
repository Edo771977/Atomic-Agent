import { expect, it } from "vitest";
import { emlExtractor, mboxExtractor } from "./email-extractor.js";

it("retains the tail of an email with 200 short parts and can select a later part", async () => {
  const raw = 'Content-Type: multipart/mixed; boundary="fixture"\r\n\r\n' +
    Array.from({ length: 200 }, (_, n) =>
      "--fixture\r\nContent-Type: text/html\r\n\r\n<p>Piece " + (n + 1) + "X</p>\r\n").join("") +
    "--fixture--";
  const input = { data: Buffer.from(raw), sourcePath: "parts.eml" };
  const all = await emlExtractor(input);
  expect(all.text.endsWith("Piece 200X")).toBe(true);
  const short = await emlExtractor({ ...input, maxBytes: 18 });
  expect(short.warnings).toContainEqual(expect.stringMatching(/part 3.*pagesFrom/i));
  const page = await emlExtractor({ ...input, pagesFrom: 198, pagesTo: 200 });
  expect(page.text).toBe("Piece 198X\n\nPiece 199X\n\nPiece 200X");
});

it("counts an alternative pair as one displayed part when continuing an EML", async () => {
  const raw = [
    'Content-Type: multipart/mixed; boundary="outer"', "", "--outer",
    'Content-Type: multipart/alternative; boundary="inner"', "", "--inner",
    "Content-Type: text/plain", "", "   ", "--inner", "Content-Type: text/html", "",
    "<p>First part</p>", "--inner--", "--outer", "Content-Type: text/plain", "",
    "Second part", "--outer--",
  ].join("\r\n");
  const result = await emlExtractor({ data: Buffer.from(raw), sourcePath: "mail.eml", pagesFrom: 2 });
  expect(result.text).toBe("Second part");
});

it("shows a bounded prefix of a first part larger than the input budget", async () => {
  const raw = "Content-Type: text/plain\r\n\r\nLog begins\n" + "x".repeat(16 * 1024 * 1024);
  const result = await emlExtractor({ data: Buffer.from(raw), sourcePath: "mail.eml", maxBytes: 32 });
  expect(result.text.startsWith("Log begins")).toBe(true);
  expect(result.text.length).toBe(32);
  expect(result.warnings).toContainEqual(expect.stringMatching(/part 1.*pagesFrom/i));
});

it("does not claim an mbox message that ran out of body capacity", async () => {
  const line = "From sender@example.test Mon Jan 1 00:00:00 2024\n";
  const data = Buffer.from(line + "Subject: First\n\n" + "a".repeat(5 * 1024 * 1024 - 50) +
    "\n\n" + line + "Subject: Second\n\nThis is the second body.");
  const result = await mboxExtractor({ data, sourcePath: "parts.mbox" });
  expect(result.pagesExtracted).toEqual([1]);
  expect(result.warnings).toContainEqual(expect.stringMatching(/message 2.*pagesFrom/i));
});
