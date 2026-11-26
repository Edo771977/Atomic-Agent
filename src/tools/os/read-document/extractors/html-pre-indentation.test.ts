import { expect, it } from "vitest";
import { boundedHtmlToMarkdown } from "./html-markdown.js";

it("keeps next-line indentation across entity callbacks after trimming a whitespace run in pre", () => {
  const warnings: string[] = [];
  const result = boundedHtmlToMarkdown(
    "<pre><code>if (ready) {" + " ".repeat(500) + "&#10;" +
      " ".repeat(1000) + "&#10;&#32;  &#32;TAILX();\n}</code></pre>",
    warnings,
  ).text;
  expect(result).toContain("if (ready) {\n    TAILX();\n}");
  expect(warnings).toContainEqual(expect.stringMatching(/preformatted.*whitespace.*trimmed/i));
});

it("preserves ordinary preformatted indentation without a warning", () => {
  const warnings: string[] = [];
  const result = boundedHtmlToMarkdown("<pre><code>First\n  second\n    third</code></pre>", warnings).text;
  expect(result).toBe("```\nFirst\n  second\n    third\n```");
  expect(warnings).toEqual([]);
});
