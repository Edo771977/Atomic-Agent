import { Parser, Tokenizer } from "htmlparser2";

const BLOCK = new Set([
  "blockquote", "br", "div", "h1", "h2", "h3", "h4", "h5", "h6", "hr",
  "li", "p", "pre", "section", "table", "td", "th", "tr",
]);
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

/** htmlparser2 uses array shifts for its HTML stack. Bound that work on deeply malformed input. */
export const HTML_PARSER_DEPTH = 2_048;

function textCollector(budget: number) {
  const parts: string[] = [];
  let length = 0;
  let cut = false;
  function append(value: string): boolean {
    const room = budget - length;
    if (room > 0 && value.length) parts.push(value.slice(0, room));
    length += Math.min(room, value.length);
    cut ||= value.length > room;
    return cut;
  }
  function edge(name: string): boolean {
    return BLOCK.has(name) && length > 0 && !parts.at(-1)?.endsWith("\n") && append("\n");
  }
  return { append, edge, result: () => ({ text: parts.join("").trim(), cut }) };
}

type TextCollector = ReturnType<typeof textCollector>;

/** The extreme-depth path keeps a stack with O(1) pushes and matching-tag lookups. */
function readDeepText(html: string, hiddenTags: ReadonlySet<string>, output: TextCollector): void {
  const stack: Array<{ name: string; previous: number | undefined }> = [];
  const top = new Map<string, number>();
  let hiddenAt: number | undefined;
  let name = "";
  let stopped = false;
  const stop = () => { stopped = true; scan.pause(); };
  const close = (index: number) => {
    while (stack.length > index) {
      const frame = stack.pop()!;
      if (frame.previous === undefined) top.delete(frame.name);
      else top.set(frame.name, frame.previous);
    }
    if (hiddenAt !== undefined && hiddenAt >= index) hiddenAt = undefined;
  };
  const open = (selfClosing: boolean) => {
    if (name === "body" && hiddenAt !== undefined && stack[hiddenAt]?.name === "head") close(hiddenAt);
    if (!selfClosing && !VOID.has(name)) {
      if (hiddenAt === undefined && (name === "title" || hiddenTags.has(name))) hiddenAt = stack.length;
      const previous = top.get(name);
      top.set(name, stack.length);
      stack.push({ name, previous });
    }
    if (hiddenAt === undefined && output.edge(name)) stop();
  };
  const scan: Tokenizer = new Tokenizer({ decodeEntities: true }, {
    onopentagname(start, end) { name = html.slice(start, end).toLowerCase(); },
    onopentagend() { open(false); },
    onselfclosingtag() { open(true); },
    onclosetag(start, end) {
      const tag = html.slice(start, end).toLowerCase();
      const index = top.get(tag);
      if (index !== undefined) close(index);
      if (hiddenAt === undefined && output.edge(tag)) stop();
    },
    ontext(start, end) { if (!stopped && hiddenAt === undefined && output.append(html.slice(start, end))) stop(); },
    ontextentity(codepoint) { if (!stopped && hiddenAt === undefined && output.append(String.fromCodePoint(codepoint))) stop(); },
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
  if (!stopped) scan.end();
}

/** Stream normal HTML so implied closes end hidden regions with their parents. */
export function readBoundedHtmlText(html: string, hiddenTags: ReadonlySet<string>, budget: number) {
  const output = textCollector(budget);
  let depth = 0;
  let hiddenDepth = 0;
  let deep = false;
  let stopped = false;
  const stop = () => { stopped = true; parser.pause(); };
  const parser: Parser = new Parser({
    onopentag(name) {
      if (stopped) return;
      if (++depth > HTML_PARSER_DEPTH) {
        deep = true;
        stop();
        return;
      }
      if (!hiddenDepth && (name === "title" || hiddenTags.has(name))) hiddenDepth = depth;
      if (!hiddenDepth && output.edge(name)) stop();
    },
    onclosetag(name) {
      if (stopped) return;
      if (hiddenDepth === depth) hiddenDepth = 0;
      if (!hiddenDepth && output.edge(name)) stop();
      depth--;
    },
    ontext(text) {
      if (!stopped && !hiddenDepth && output.append(text)) stop();
    },
  }, { decodeEntities: true, recognizeSelfClosing: true });
  for (let offset = 0; offset < html.length && !stopped; offset += 16_384) {
    parser.write(html.slice(offset, offset + 16_384));
  }
  if (!stopped) parser.end();
  if (!deep) return output.result();
  const deepOutput = textCollector(budget);
  readDeepText(html, hiddenTags, deepOutput);
  return deepOutput.result();
}
