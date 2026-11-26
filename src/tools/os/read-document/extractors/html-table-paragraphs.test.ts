import { expect, it } from "vitest";
import { boundedHtmlToMarkdown } from "./html-markdown.js";

it.each([
  ["cells", "<table><tr><td><p>a<td><p>b</table>", "| a | b |"],
  ["rows", "<table><tr><td><p>a<tr><td><p>b</table>", "| a |\n| --- |\n| b |"],
  ["bold", "<table><tr><td><p>a<b>x<td><p>b</table>", "| a**x** | b |"],
  ["div", "<table><tr><td><p>a<td><div>b</table>", "| a | b |"],
  ["Outlook spans", "<table><tr><td><p class=MsoNormal><span>a<o:p></o:p></span><td><p class=MsoNormal>b</table>", "| a | b |"],
  ["headers", "<table><tr><th><p>H1<th><p>H2<tr><td><p>a<td><p>b</table>", "| H1 | H2 |\n| --- | --- |\n| a | b |"],
])("keeps optional paragraph and cell endings inside the table (%s)", (_name, html, row) => {
  const result = boundedHtmlToMarkdown(html, []).text;
  expect(result.split("\n").every((line) => line.startsWith("|"))).toBe(true);
  expect(result).toContain(row);
});
