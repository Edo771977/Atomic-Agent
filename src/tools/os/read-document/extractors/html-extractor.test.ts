import { describe, expect, it } from "vitest";

import { htmlExtractor } from "./html-extractor.js";

const run = (html: string | Buffer) =>
  htmlExtractor({
    data: typeof html === "string" ? Buffer.from(html, "utf8") : html,
    sourcePath: "page.html",
  });

describe("htmlExtractor", () => {
  it("honours XHTML self-closing anchors and page markers without losing Markdown", async () => {
    const paragraphs = Array.from({ length: 300 }, (_, i) =>
      `<a id="n${i}"/><span epub:type="pagebreak" id="page_${i}"/><h2>Section ${i}</h2>` +
      `<p><a href="https://example.test/${i}">Reference</a></p>`).join("");
    const result = await run(`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body>${paragraphs}</body></html>`);
    expect(result.text.match(/^## Section /gm)).toHaveLength(300);
    expect(result.text.match(/https:\/\/example\.test\//g)).toHaveLength(300);
    expect(result.warnings).toEqual([]);
  });

  it("counts a slash on a non-void HTML element as an opening tag", async () => {
    const result = await run("<p>Fixture</p>" + "<div/>".repeat(1_010) + "Deep text");
    expect(result.warnings.join("\n")).toMatch(/depth/i);
  });

  it("finds the body after a large head, comments and styles", async () => {
    const css = ".item { color: navy; }".repeat(3_600);
    const result = await run(`<!doctype html><html><head><title>Report</title><style>${css}</style></head>` +
      `<body><!-- ${css} --><style>${css}</style><script>hidden()</script><p>Visible report body</p></body></html>`);
    expect(result.text).toBe("# Report\n\nVisible report body");
    expect(result.warnings).toEqual([]);
  });

  it("keeps every sibling paragraph in a normal page", async () => {
    const paragraphs = Array.from({ length: 401 }, (_, index) => `Paragraph ${index + 1}`);
    const result = await run(paragraphs.map(text => `<p>${text}</p>`).join(""));
    expect(result.text.split("\n\n")).toEqual(paragraphs);
    expect(result.warnings).toEqual([]);
  });

  it("preserves links in a newsletter with 150 items", async () => {
    const items = Array.from({ length: 150 }, (_, index) =>
      `<p><a href="https://example.test/news/${index}">News item ${index}</a></p>`);
    const result = await run(items.join(""));
    expect(result.text.match(/https:\/\/example\.test\/news\//g)).toHaveLength(150);
    expect(result.text).toContain("[News item 149](https://example.test/news/149)");
    expect(result.warnings).toEqual([]);
  });

  it("extracts a roughly 183 KiB article in full", async () => {
    const paragraphs = Array.from({ length: 173 }, (_, index) =>
      `Section ${index + 1} ${"A normal paragraph in a local article. ".repeat(27).trim()}`);
    const result = await run(`<article>${paragraphs.map(text => `<p>${text}</p>`).join("")}</article>`);
    expect(result.text).toBe(paragraphs.join("\n\n"));
    expect(result.warnings).toEqual([]);
  });

  it.each([10_000, Math.floor(8 * 1024 * 1024 / 11)])("uses bounded plain text for %i nested elements", async (depth) => {
    const start = performance.now();
    const result = await run("<p>Visible fixture</p>" + "<div>".repeat(depth) + "nested" + "</div>".repeat(depth));
    expect(performance.now() - start).toBeLessThan(2_000);
    expect(result.text).toContain("Visible fixture");
    expect(result.text).toContain("nested");
    expect(result.warnings.join("\n")).toMatch(/HTML.*depth.*plain text/i);
  });
  it("renders the body as markdown and drops scripts, styles and head", async () => {
    const result = await run(
      `<!doctype html><html><head><title>Report</title><style>.x{}</style><script>alert(1)</script></head>` +
        `<body><h2>Results</h2><p>See <a href="https://example.com">the site</a>.</p>` +
        `<script>track()</script><ol><li>first</li></ol></body></html>`,
    );
    expect(result.format).toBe("html");
    expect(result.text.startsWith("# Report\n\n## Results")).toBe(true);
    expect(result.text).toContain("[the site](https://example.com)");
    expect(result.text).toContain("1.  first");
    expect(result.text).not.toContain("alert");
    expect(result.text).not.toContain("track()");
    expect(result.text).not.toContain(".x{}");
    expect(result.warnings).toEqual([]);
  });

  it("keeps tables as pipe rows", async () => {
    const result = await run(
      "<table><thead><tr><th>Item</th><th>Qty</th></tr></thead><tbody><tr><td>Apple</td><td>3</td></tr></tbody></table>",
    );
    expect(result.text).toBe("| Item | Qty |\n| --- | --- |\n| Apple | 3 |");
  });

  it("honours a declared legacy charset", async () => {
    const head = Buffer.from('<html><head><meta charset="windows-1251"></head><body><p>', "latin1");
    const word = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]); // "Привет" in cp1251
    const tail = Buffer.from("</p></body></html>", "latin1");
    const result = await run(Buffer.concat([head, word, tail]));
    expect(result.text).toBe("Привет");
  });

  it("does not repeat the title when the body already opens with it", async () => {
    const result = await run("<html><head><title>Same</title></head><body><h1>Same</h1><p>x</p></body></html>");
    expect(result.text).toBe("# Same\n\nx");
  });
});
