import { expect, it } from "vitest";
import { readBoundedHtmlText } from "./html-plain-text.js";

it.each(["canvas", "object", "template", "iframe"])("keeps text after a self-closed or unclosed %s", tag => {
  const hidden = new Set([tag]);
  for (const opening of [`<${tag}/>`, `<${tag}>`]) {
    const html = `<p>Before</p><div>${opening}</div><p>After</p><p>Tail</p>`;
    expect(readBoundedHtmlText(html, hidden, 1_000)).toEqual({ text: "Before\nAfter\nTail", cut: false });
  }
});
