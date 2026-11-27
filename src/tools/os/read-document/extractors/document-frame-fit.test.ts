import JSZip from "jszip";
import { expect, it } from "vitest";
import { emlExtractor } from "./email-extractor.js";
import { epubExtractor } from "./epub-extractor.js";

it("keeps twenty full EML bodies when repeated To headers would fill the window", async () => {
  const recipients = Array.from({ length: 60 }, (_, n) => "recipient" + n + "@example.test").join(", ");
  const bodies = Array.from({ length: 20 }, (_, n) => "BODY-" + (n + 1) + "-" + "x".repeat(124) + "-END");
  const data = Buffer.from("To: " + recipients + "\r\n" +
    'Content-Type: multipart/mixed; boundary="fixture"\r\n\r\n' +
    bodies.map((body) => "--fixture\r\nContent-Type: text/plain\r\n\r\n" + body + "\r\n").join("") +
    "--fixture--");
  const shown: string[] = [];
  let pagesFrom = 1;
  for (let calls = 0; calls < 20; calls++) {
    const result = await emlExtractor({ data, sourcePath: "fixture.eml", maxBytes: 1600, pagesFrom });
    shown.push(...result.text.split("\n").filter((line) => line.startsWith("BODY-")));
    const next = result.warnings.join("\n").match(/pagesFrom=(\d+)/)?.[1];
    if (!next) break;
    expect(Number(next)).toBeGreaterThan(pagesFrom);
    pagesFrom = Number(next);
  }
  expect(shown).toEqual(bodies);
});

it("shows the end of a chapter that fits without the long book title", async () => {
  const zip = new JSZip();
  zip.file("book.opf", "<package><metadata><title>" + "t".repeat(330) +
    '</title></metadata><manifest><item id="c" href="chapter.xhtml"/></manifest><spine>' +
    '<itemref idref="c"/></spine></package>');
  zip.file("chapter.xhtml", "<p>CH1START " + "x".repeat(797) + " CH1END</p>");
  const data = await zip.generateAsync({ type: "nodebuffer" });
  const result = await epubExtractor({ data, sourcePath: "fixture.epub", maxBytes: 1000, pagesFrom: 1 });
  expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(1000);
  expect(result.text).toContain("CH1END");
  expect(result.pagesExtracted).toEqual([1]);
  expect(result.truncated).toBe(true);
  expect(result.warnings).toContainEqual(expect.stringMatching(/title.*omitted.*maxBytes/i));
});
