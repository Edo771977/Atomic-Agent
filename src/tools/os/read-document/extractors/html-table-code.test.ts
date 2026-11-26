import { marked } from "marked";
import { expect, it } from "vitest";
import { boundedHtmlToMarkdown } from "./html-markdown.js";

it("keeps a literal backslash before a pipe in inline code in a table", async () => {
  const text = boundedHtmlToMarkdown(
    "<table><tr><th>Pattern</th><th>Value</th></tr>" +
      "<tr><td><code>left &#92;| right &lt;x&gt; _ok_</code></td><td>Still here</td></tr></table>",
    [],
  ).text;
  expect(text.includes("&#92;")).toBe(false);
  expect(text).toContain("left " + "\\".repeat(3) + "| right");
  expect(text).toContain("\\|");
  const html = await marked.parse(text);
  expect(html.match(/<td>/g)).toHaveLength(2);
  expect(html).toContain("<td>Still here</td>");
  const code = /<code>(.*?)<\/code>/.exec(html)?.[1];
  expect(code?.replaceAll(/&#(\d+);/g, (_match, value: string) => String.fromCharCode(Number(value)))
    .replaceAll("&lt;", "<").replaceAll("&gt;", ">")).toBe("left \\| right <x> _ok_");
});

it("keeps standard Markdown backticks for code without that ambiguity", () => {
  const text = boundedHtmlToMarkdown(
    "<table><tr><th>Pattern</th></tr><tr><td><code>left | right</code></td></tr></table>",
    [],
  ).text;
  expect(text).toContain("`left \\| right`");
});
