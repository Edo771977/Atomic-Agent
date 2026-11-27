import { expect, it } from "vitest";
import { emlExtractor, mboxExtractor } from "./email-extractor.js";

it("offers only the body cursor until all MIME bodies have been shown", async () => {
  const parts = ["BODY-1 " + "x".repeat(65), "BODY-2 " + "x".repeat(65), "BODY-3 " + "x".repeat(65)]
    .map((body) => "Content-Type: text/plain\r\n\r\n" + body);
  parts.splice(1, 0, "Content-Type: application/octet-stream\r\n" +
    "Content-Disposition: attachment; filename=receipts.bin\r\n\r\nsmall");
  const data = Buffer.from('Content-Type: multipart/mixed; boundary="parts"\r\n\r\n' +
    parts.map((part) => "--parts\r\n" + part + "\r\n").join("") + "--parts--");
  const input = { data, sourcePath: "fixture.eml", maxBytes: 100 };
  let pagesFrom = 1;
  for (const expected of [1, 2, 3]) {
    const result = await emlExtractor({ ...input, pagesFrom });
    expect(result.text).toContain("BODY-" + expected);
    const cursors = Array.from(result.warnings.join("\n").matchAll(/pagesFrom=(\d+)/g), (match) => Number(match[1]));
    expect(cursors).toEqual([expected + 1]);
    pagesFrom = cursors[0]!;
  }
  const attachment = await emlExtractor({ ...input, pagesFrom });
  expect(attachment.text).toContain("receipts.bin");
});

it("puts the MBOX body cursor before a retry for deferred attachments", async () => {
  const data = Buffer.from(
    'From first\nContent-Type: multipart/mixed; boundary="parts"\n\n' +
    "--parts\nContent-Type: text/plain\n\nBODY-1 " + "x".repeat(50) + "\n" +
    "--parts\nContent-Type: application/octet-stream\n" +
    "Content-Disposition: attachment; filename=" + "a".repeat(150) + ".bin\n\nsmall\n" +
    "--parts--\n\nFrom second\n\nBODY-2 " + "y".repeat(50),
  );
  const input = { data, sourcePath: "fixture.mbox", maxBytes: 100 };
  const first = await mboxExtractor(input);
  expect(first.text).toContain("BODY-1");
  expect(first.warnings[0]).toMatch(/message 2.*pagesFrom=2/i);
  expect(first.warnings[1]).toMatch(/attachments.*pagesFrom=1.*body continuation first/i);
  const next = await mboxExtractor({ ...input, pagesFrom: 2 });
  expect(next.text).toContain("BODY-2");
});
