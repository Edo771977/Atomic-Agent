import { expect, it } from "vitest";
import { emlExtractor } from "./email-extractor.js";

it("shows an attachment-only forwarded message on the window that owns it", async () => {
  const text = (body: string) => "--parts\r\nContent-Type: text/plain\r\n\r\n" + body + "\r\n";
  const forwarded = "--parts\r\nContent-Type: message/rfc822\r\n\r\nSubject: Forwarded receipt\r\n" +
    'Content-Type: application/pdf\r\nContent-Disposition: attachment; filename="forward.pdf"\r\n\r\nPDF\r\n';
  const raw = 'Content-Type: multipart/mixed; boundary="parts"\r\n\r\n' +
    text("First " + "x".repeat(75)) + text("Second " + "y".repeat(86)) +
    forwarded + text("Third body") + "--parts--";
  const input = { data: Buffer.from(raw), sourcePath: "fixture.eml", maxBytes: 150 };
  const first = await emlExtractor(input);
  expect(first.warnings).toContainEqual(expect.stringMatching(/pagesFrom=2/));
  expect(first.text).not.toContain("Forwarded receipt");
  const later = await emlExtractor({ ...input, maxBytes: 260, pagesFrom: 2 });
  expect(later.text).toContain("Second ");
  expect(later.text).toContain("forward.pdf");
  expect(later.text).toContain("Third body");

  const third = await emlExtractor({ ...input, maxBytes: 260, pagesFrom: 3 });
  expect(third.text).not.toContain("Second ");
  expect(third.text).toContain("forward.pdf");
  expect(third.text).toContain("Third body");
});
