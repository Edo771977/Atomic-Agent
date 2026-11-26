import { performance } from "node:perf_hooks";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { emlExtractor } from "./email-extractor.js";
import { epubExtractor } from "./epub-extractor.js";

async function epub(chapters: string[]) {
  const zip = new JSZip();
  const ids = chapters.map((chapter, index) => {
    const id = "c" + index;
    zip.file(id + ".xhtml", chapter);
    return id;
  });
  zip.file("book.opf", "<package><manifest>" +
    ids.map((id) => '<item id="' + id + '" href="' + id + '.xhtml"/>').join("") +
    "</manifest><spine>" + ids.map((id) => '<itemref idref="' + id + '"/>').join("") +
    "</spine></package>");
  return zip.generateAsync({ type: "nodebuffer" });
}

function mime(parts: string[]): Buffer {
  return Buffer.from('Content-Type: multipart/mixed; boundary="fixture"\r\n\r\n' +
    parts.map((part) => "--fixture\r\nContent-Type: text/html\r\n\r\n" + part + "\r\n").join("") +
    "--fixture--\r\n");
}

describe("cumulative formatting work", () => {
  const heavy = "<ul>" + "<li><a href='/ref'>A list item.</a></li>".repeat(400) + "</ul>";
  const many = Array.from({ length: 128 }, (_, n) => "<h2>Section " + n + "</h2>" + heavy);

  it("uses plain text for later EPUB chapters when formatting work is exhausted", async () => {
    const data = await epub(many);
    const start = performance.now();
    const result = await epubExtractor({ data, sourcePath: "fixture.epub" });
    expect(result.text).toContain("## Section 0");
    expect(result.text).not.toContain("## Section 120");
    expect(result.text.includes("Section 127")).toBe(true);
    expect(result.warnings).toContainEqual(expect.stringMatching(/formatting budget.*plain text/i));
    expect(performance.now() - start).toBeLessThan(3000);
  });

  it("uses plain text for later MIME parts when formatting work is exhausted", async () => {
    const data = mime(many);
    const start = performance.now();
    const result = await emlExtractor({ data, sourcePath: "fixture.eml" });
    expect(result.text).toContain("## Section 0");
    expect(result.text).not.toContain("## Section 120");
    expect(result.text.includes("Section 127")).toBe(true);
    expect(result.warnings).toContainEqual(expect.stringMatching(/formatting budget.*plain text/i));
    expect(performance.now() - start).toBeLessThan(3000);
  });

  it("preserves ordinary formatting in all 50 chapters and all 10 email parts", async () => {
    const sections = (count: number) =>
      Array.from({ length: count }, (_, n) => "<h2>Chapter " + n + "</h2><p><a href='/ref'>Reference</a></p>");
    const chapters = await epubExtractor({ data: await epub(sections(50)), sourcePath: "book.epub" });
    const email = await emlExtractor({ data: mime(sections(10)), sourcePath: "mail.eml" });
    const markdown = (n: number) => "## Chapter " + n + "\n\n[Reference](/ref)";
    expect(chapters.text).toBe(Array.from({ length: 50 }, (_, n) =>
      "--- chapter " + (n + 1) + " ---\n" + markdown(n)).join("\n\n"));
    expect(email.text).toBe(Array.from({ length: 10 }, (_, n) => markdown(n)).join("\n\n"));
    expect(chapters.warnings).toEqual([]);
    expect(email.warnings).toEqual([]);
  });
});
