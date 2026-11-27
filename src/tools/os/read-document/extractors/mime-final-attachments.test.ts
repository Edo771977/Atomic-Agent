import { expect, it } from "vitest";
import { emlExtractor } from "./email-extractor.js";

const boundary = "--fixture\r\n";
const html = (text: string) => boundary + "Content-Type: text/html\r\n\r\n" + text + "\r\n";
const attachment = (name: string) => boundary + "Content-Type: application/octet-stream\r\n" +
  "Content-Disposition: attachment; filename=" + name + "\r\n\r\nx\r\n";

it.each([undefined, 1, 2])("offers both attachments after the final text part is cut (pagesFrom=%s)", async (pagesFrom) => {
  const data = Buffer.from('Content-Type: multipart/mixed; boundary="fixture"\r\n\r\n' +
    html("<h1>First</h1>") + attachment("A1.bin") +
    html("<h2>Last</h2><p>" + "x".repeat(3000) + "</p>") + attachment("A2.bin") + "--fixture--");
  const input = { data, sourcePath: "fixture.eml", maxBytes: 1000 };
  let result = await emlExtractor({ ...input, pagesFrom });
  // When the oversized final body is deferred, read it before the listings.
  if (result.warnings.some((warning) => warning.includes("at part 2"))) {
    result = await emlExtractor({ ...input, pagesFrom: 2 });
  }
  expect(result.warnings).toContainEqual(expect.stringMatching(/MIME part 2 was truncated/));
  const resume = result.warnings.find((warning) => /attachments.*pagesFrom=/i.test(warning));
  const next = Number(resume?.match(/pagesFrom=(\d+)/)?.[1]);
  expect(next).toBe(3);
  const listings = await emlExtractor({ ...input, pagesFrom: next });
  expect(listings.text).toContain("A1.bin");
  expect(listings.text).toContain("A2.bin");
  expect(listings.warnings).toEqual([]);
});
