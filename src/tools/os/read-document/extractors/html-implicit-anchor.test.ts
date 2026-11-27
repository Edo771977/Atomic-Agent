import { expect, it } from "vitest";
import { boundedHtmlToMarkdown } from "./html-markdown.js";

it.each([
  ["cells", "<table><tr><td><a href=1>one<td><a href=2>two</table>"],
  ["items", "<ul><li><a href=1>one<li><a href=2>two<li>three</ul>"],
  ["div", "<div><a href=1>one<div><a href=2>two"],
  ["pre", "<a href=1>one<pre>Code</pre><a href=2>two"],
  ["form", "<a href=1>one<form>Form<a href=2>two"],
  ["address", "<a href=1>one<address><p>Address<a href=2>two"],
  ["select", "<a href=1>one<select><option>Option<a href=2>two"],
  ["button", "<a href=1>one<button>Button<a href=2>two"],
])("retains the first link before overlapping anchors in %s", (_tag, html) => {
  const result = boundedHtmlToMarkdown(html, []).text;
  expect(result).toContain("[one](1)");
  if (_tag !== "select" && _tag !== "button") expect(result).toContain("[two](2)");
});

it("preserves the first URL when its prefix is whitespace before an overlapping div", () => {
  const html = "<a href='/first'> <div><a href='/second'>Second</a></div></a>";
  const result = boundedHtmlToMarkdown(html, []).text;
  expect(result.match(/\]\(\/first\)/g)).toHaveLength(1);
  expect(result).toContain("[/first](/first)");
  expect(result).toContain("[Second](/second)");
});
