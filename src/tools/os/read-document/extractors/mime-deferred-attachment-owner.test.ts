import { expect, it } from "vitest";
import { emlExtractor } from "./email-extractor.js";

it("identifies the source message for the first deferred attachment", async () => {
  const name = "forwarded-" + "x".repeat(110) + ".bin";
  const raw = 'Content-Type: multipart/mixed; boundary="parts"\r\n\r\n' +
    "--parts\r\nContent-Type: text/plain\r\n\r\nOne complete body\r\n" +
    "--parts\r\nContent-Type: message/rfc822\r\n\r\nSubject: Forwarded receipt\r\n" +
    "Content-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=" +
    name + "\r\n\r\nstub\r\n--parts--";
  const result = await emlExtractor({ data: Buffer.from(raw), sourcePath: "fixture.eml", maxBytes: 100 });
  expect(result.text).toContain("One complete body");
  expect(result.warnings).toContainEqual(expect.stringMatching(/attachments.*pagesFrom=2.*Forwarded receipt/i));
});
