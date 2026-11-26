import { expect, it } from "vitest";
import { boundedHtmlToMarkdown } from "./html-markdown.js";

it("keeps line breaks throughout a gallery of 300 images", () => {
  const html = Array.from({ length: 300 }, (_, n) =>
    '<img src="/photo/' + n + '" alt="Photo ' + n + '"><br>').join("");
  const result = boundedHtmlToMarkdown("<p>" + html + "</p><hr><p>TAILX</p>", []).text;
  expect(result.match(/^!\[Photo \d+\]\(\/photo\/\d+\)$/gm)).toHaveLength(300);
  expect(result).toContain("TAILX");
  expect(result).toContain("* * *");
});
