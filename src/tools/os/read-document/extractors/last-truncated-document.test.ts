import JSZip from "jszip";
import { expect, it } from "vitest";
import { emlExtractor, mboxExtractor } from "./email-extractor.js";
import { epubExtractor } from "./epub-extractor.js";

it.each(["eml", "mbox", "epub"] as const)("does not suggest an out-of-range cursor for a truncated final %s item", async (format) => {
  const body = "Visible beginning " + "x".repeat(2500);
  let input: Buffer;
  if (format === "epub") {
    const zip = new JSZip();
    zip.file("book.opf", '<package><manifest><item id="c" href="c.xhtml"/></manifest><spine><itemref idref="c"/></spine></package>');
    zip.file("c.xhtml", "<p>" + body + "</p>");
    input = await zip.generateAsync({ type: "nodebuffer" });
  } else {
    const envelope = format === "mbox" ? "From sender@example.test Fri Nov 27 00:00:00 2026\n" : "";
    input = Buffer.from(envelope + "Content-Type: text/plain\r\n\r\n" + body);
  }
  const extract = format === "eml" ? emlExtractor : format === "mbox" ? mboxExtractor : epubExtractor;
  const result = await extract({ data: input, sourcePath: "fixture." + format, maxBytes: 150 });
  expect(result.text).toContain("Visible beginning");
  expect(result.truncated).toBe(true);
  expect(result.warnings).toContainEqual(expect.stringMatching(/(?:part|chapter|message) 1 was truncated/i));
  expect(result.warnings.join(" ")).not.toContain("pagesFrom=2");
});

it("explains an empty window when the header leaves no room for the body", async () => {
  const data = Buffer.from("To: " + "reader@example.test, ".repeat(75) +
    "\r\nContent-Type: text/plain\r\n\r\nVisible body" + "x".repeat(3000));
  const result = await emlExtractor({ data, sourcePath: "fixture.eml", maxBytes: 1000 });
  expect(result.text).toBe("");
  expect(result.warnings).toContainEqual(expect.stringMatching(/no body text was shown.*headers.*maxBytes.*pagesFrom=1/i));
});
