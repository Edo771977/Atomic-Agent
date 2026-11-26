import { expect, it } from "vitest";
import { emlExtractor } from "./email-extractor.js";

it("limits cumulative conversions across the parts of one MIME message", async () => {
  const html = (content: string) =>
    '--outer\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<h2>' + content + "</h2>\r\n";
  const forwarded = "--outer\r\nContent-Type: message/rfc822\r\n\r\n" +
    "Subject: Forwarded\r\nContent-Type: text/html\r\n\r\n<p>Inner copy</p>\r\n";
  const message = 'Content-Type: multipart/mixed; boundary="outer"\r\n\r\n' +
    html("First fixture") + forwarded.repeat(130) + html("TAILX") + "--outer--";
  const result = await emlExtractor({ data: Buffer.from(message), sourcePath: "fixture.eml" });
  expect(result.text).toContain("## First fixture");
  expect(result.text).toContain("Inner copy");
  expect(result.text).not.toContain("TAILX");
  expect(result.warnings).toContainEqual(expect.stringMatching(/MIME.*budget.*skipped/i));
});
