import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { boundedHtmlToMarkdown } from "./html-markdown.js";

it("normalizes Unicode whitespace in image labels and titles and keeps the tail", () => {
  const spaces = "\u0085\u00a0\u3000 ".repeat(140);
  const alt = spaces + "Photo" + spaces + "label" + spaces;
  const title = spaces + "Photo" + spaces + "title" + spaces;
  const html = '<img src="/photo.png" alt="' + alt + '" title="' + title + '">' +
    ('<img alt="' + alt + '">').repeat(122) + "<p>TAILX</p>";
  expect(Buffer.byteLength(html)).toBeGreaterThan(400_000);
  const warnings: string[] = [];
  const start = performance.now();
  const result = boundedHtmlToMarkdown(html, warnings).text;
  expect(performance.now() - start).toBeLessThan(2000);
  expect(result.slice(0, 100)).toContain('![Photo label](/photo.png "Photo title")');
  expect(result.match(/Photo label/g)).toHaveLength(123);
  expect(result).toContain("TAILX");
  expect(warnings).toEqual([]);
});
