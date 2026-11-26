import { marked } from "marked";
import { expect, it } from "vitest";
import { boundedHtmlToMarkdown } from "./html-markdown.js";

it("escapes pipes in both cells even when the cell already contains a backslash", async () => {
  const text = boundedHtmlToMarkdown(
    "<table><tr><th>One</th><th>Two</th></tr>" +
      "<tr><td>Plain | pipe</td><td>Backslash &#92;| pipe</td></tr></table>",
    [],
  ).text;
  const html = await marked.parse(text);
  expect(html.match(/<td>/g)).toHaveLength(2);
  expect(html).toContain("<td>Plain | pipe</td>");
  expect(html).toContain("<td>Backslash \\| pipe</td>");
});
