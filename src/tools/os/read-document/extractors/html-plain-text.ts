import { Tokenizer } from "htmlparser2";

const BLOCK = new Set([
  "blockquote", "br", "div", "h1", "h2", "h3", "h4", "h5", "h6", "hr",
  "li", "p", "pre", "section", "table", "td", "th", "tr",
]);

/** Read text iteratively, even after the formatting parser reaches its depth limit. */
export function readBoundedHtmlText(html: string, hiddenTags: ReadonlySet<string>, budget: number) {
  const parts: string[] = [];
  let length = 0;
  let cut = false;
  let hidden: string | undefined;
  let hiddenDepth = 0;
  let tag = "";
  const append = (text: string) => {
    const room = budget - length;
    if (room > 0 && text.length) parts.push(text.slice(0, room));
    length += Math.min(room, text.length);
    if (text.length > room) {
      cut = true;
      scan.pause();
    }
  };
  const gap = () => {
    if (length && !parts.at(-1)?.endsWith("\n")) append("\n");
  };
  const open = (selfClosing: boolean) => {
    // A body opening also ends an omitted, implicitly closed HTML head.
    if (tag === "body" && hidden === "head") {
      hidden = undefined;
      hiddenDepth = 0;
    }
    if (hidden) {
      if (tag === hidden) hiddenDepth++;
    } else if (tag !== "embed" && !(selfClosing && tag === "svg") &&
        (tag === "title" || hiddenTags.has(tag))) {
      hidden = tag;
      hiddenDepth = 1;
    } else if (BLOCK.has(tag)) {
      gap();
    }
  };
  const scan: Tokenizer = new Tokenizer({ decodeEntities: true }, {
    onopentagname(start, end) { tag = html.slice(start, end).toLowerCase(); },
    onopentagend() { open(false); },
    onselfclosingtag() { open(true); },
    onclosetag(start, end) {
      const name = html.slice(start, end).toLowerCase();
      if (hidden) {
        if (name === hidden && --hiddenDepth === 0) hidden = undefined;
      } else if (BLOCK.has(name)) {
        gap();
      }
    },
    ontext(start, end) { if (!hidden && !cut) append(html.slice(start, end)); },
    ontextentity(codepoint) { if (!hidden && !cut) append(String.fromCodePoint(codepoint)); },
    onattribname() {},
    onattribdata() {},
    onattribend() {},
    onattribentity() {},
    oncomment() {},
    oncdata() {},
    ondeclaration() {},
    onprocessinginstruction() {},
    onend() {},
  });
  scan.write(html);
  if (!cut) scan.end();
  return { text: parts.join("").trim(), cut };
}
