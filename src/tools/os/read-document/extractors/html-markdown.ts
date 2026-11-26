import { parseHTML } from "linkedom";
import { Parser } from "htmlparser2";
import TurndownService from "turndown";
import { readBoundedHtmlText } from "./html-plain-text.js";

/**
 * HTML → light markdown for documents on disk (saved web pages, EPUB
 * chapters, HTML mail bodies). Built on the same two libraries web fetch
 * already ships (`linkedom` for the DOM, `turndown` for markdown), so this
 * adds no dependency.
 *
 * Unlike web fetch we do NOT run Readability here: it is tuned for news
 * articles and drops content it scores as boilerplate, which on a local
 * document (a manual, a table-heavy report, an e-book chapter) is often
 * the content itself. We only strip elements that are never document text.
 */
const DROP_ELEMENTS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "iframe",
  "object",
  "embed",
  "svg",
  "canvas",
  "head",
]);
const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const HTML_FORMAT_CHARS = 384 * 1024;
const HTML_FORMAT_DEPTH = 128;
const HTML_FORMAT_NODES = 6_000;
const HTML_QUOTE_DEPTH = 8;
const HTML_TABLE_DEPTH = 4;
const HTML_TABLE_COLUMNS = 64;
const HTML_TITLE_CHARS = 1_024;

type FormatLimit = "size" | "depth" | "nodes" | "quotes" | "table" | "output";

class HtmlFormatLimit extends Error {
  constructor(readonly limit: FormatLimit) { super(limit); }
}

// Turndown uses its own DOM implementation on Node.js. The production
// tsconfig intentionally does not include browser DOM types.
interface MarkdownNode {
  readonly nodeName: string;
  readonly parentNode: MarkdownNode | null;
  readonly childNodes: ArrayLike<MarkdownNode>;
}

function tableNesting(node: object): number {
  let count = 0;
  for (let parent = (node as MarkdownNode).parentNode; parent; parent = parent.parentNode) {
    if (parent.nodeName === "TABLE") count++;
  }
  return count;
}

function outerRowWidth(table: MarkdownNode): number {
  let width = 0;
  for (const child of Array.from(table.childNodes)) {
    if (child.nodeName === "TR") {
      const cells = Array.from(child.childNodes).filter(cell => cell.nodeName === "TD" || cell.nodeName === "TH");
      width = Math.max(width, cells.length);
    } else if (child.nodeName === "THEAD" || child.nodeName === "TBODY" || child.nodeName === "TFOOT") {
      width = Math.max(width, outerRowWidth(child));
    }
  }
  return width;
}

function makeTurndown(textChars: number): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  // Turndown core has no table support: every cell becomes its own
  // paragraph and the row/column shape is lost. Render tables as pipe rows
  // with a header separator so a local model can still read them as a grid.
  td.addRule("tableCell", {
    filter: ["th", "td"],
    replacement: (content, node) => {
      const text = content.replace(/\n/g, " ").replace(/ {2,}/g, " ").trim();
      return tableNesting(node) > 1 ? ` ${text}` : ` ${text.replace(/\\?\|/g, "\\|")} |`;
    },
  });
  td.addRule("tableRow", {
    filter: "tr",
    replacement: (content, node) => tableNesting(node) > 1 ? ` ${content.trim()}` : `\n|${content}`,
  });
  td.addRule("tableSection", {
    filter: ["thead", "tbody", "tfoot"],
    replacement: (content) => content,
  });
  td.addRule("table", {
    filter: "table",
    replacement: (content, node) => {
      if (tableNesting(node)) return ` ${content.trim()}`;
      const columns = outerRowWidth(node as unknown as MarkdownNode);
      if (columns > HTML_TABLE_COLUMNS) throw new HtmlFormatLimit("table");
      const rows = content
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("|"));
      if (rows.length === 0 || columns === 0) return "\n\n";
      const separator = `|${" --- |".repeat(columns)}`;
      return `\n\n${[rows[0], separator, ...rows.slice(1)].join("\n")}\n\n`;
    },
  });
  td.remove(["button", "input", "select", "textarea"]);
  let spent = textChars;
  const charge = (amount: number) => {
    spent += amount;
    if (spent > HTML_FORMAT_CHARS) throw new HtmlFormatLimit("output");
  };
  const escape = td.escape.bind(td);
  td.escape = (text) => {
    const result = escape(text);
    charge(Math.max(0, result.length - text.length));
    return result;
  };
  // Turndown resolves each rule before recursing into its children. Wrap
  // replacements per conversion so intermediate growth is charged too.
  const { rules } = td;
  const ruleFor = rules.forNode.bind(rules);
  rules.forNode = (node) => {
    const rule = ruleFor(node);
    const replace = rule.replacement;
    if (!replace) return rule;
    return { ...rule, replacement(content, target, options) {
      const result = replace.call(rule, content, target, options);
      charge(2 + Math.max(0, result.length - content.length));
      return result;
    } };
  };
  return td;
}

export interface HtmlMarkdown {
  text: string;
  title?: string;
}

/**
 * Strip non-visible markup and check the depth before giving any parser
 * that builds a DOM or renders recursively a bounded fragment.
 */
function prepareHtml(html: string) {
  const parts: string[] = [];
  let length = 0;
  let depth = 0;
  let omittedDepth = 0;
  let titleDepth = 0;
  let rawTitle: string | undefined;
  let limit: FormatLimit | undefined;
  let nodes = 0;
  let quotes = 0;
  let tables = 0;
  let textChars = 0;

  const stop = (reason: FormatLimit) => {
    limit = reason;
    parser.pause();
  };
  const append = (text: string, allowPartial: boolean) => {
    const available = HTML_FORMAT_CHARS - length;
    if (text.length <= available) {
      parts.push(text);
      length += text.length;
    } else {
      if (allowPartial && available > 0) parts.push(text.slice(0, available));
      stop("size");
    }
  };
  const appendTag = () => append(html.slice(parser.startIndex, parser.endIndex + 1), false);
  const parser: Parser = new Parser({
    onopentag(name, _attributes, implied) {
      if (limit) return;
      depth++;
      if (!VOID_ELEMENTS.has(name) && depth > HTML_FORMAT_DEPTH) return stop("depth");
      if (name === "blockquote" && ++quotes > HTML_QUOTE_DEPTH) return stop("quotes");
      if (name === "table" && ++tables > HTML_TABLE_DEPTH) return stop("table");
      if (name === "title" && rawTitle === undefined) {
        titleDepth = depth;
        rawTitle = "";
      }
      if (!omittedDepth && (name === "title" || DROP_ELEMENTS.has(name))) omittedDepth = depth;
      if (!omittedDepth && !implied) {
        if (++nodes > HTML_FORMAT_NODES) return stop("nodes");
        appendTag();
      }
    },
    onclosetag(name, implied) {
      if (limit) return;
      if (titleDepth === depth) titleDepth = 0;
      if (omittedDepth === depth) omittedDepth = 0;
      else if (!omittedDepth && !implied) appendTag();
      if (name === "blockquote") quotes--;
      if (name === "table") tables--;
      depth--;
    },
    ontext(text) {
      if (limit) return;
      if (titleDepth) rawTitle += text.slice(0, HTML_TITLE_CHARS - (rawTitle?.length ?? 0));
      if (!omittedDepth) {
        if (++nodes > HTML_FORMAT_NODES) return stop("nodes");
        textChars += text.length;
        append(text, true);
      }
    },
  }, { decodeEntities: false });
  parser.end(html);
  const title = rawTitle
    ? parseHTML(`<html><head><title>${rawTitle}</title></head><body></body></html>`)
      .document.querySelector("title")?.textContent?.trim() || undefined
    : undefined;
  return { markup: parts.join(""), title, limit, textChars };
}

export function boundedHtmlToMarkdown(html: string, warnings: string[]): HtmlMarkdown {
  const prepared = prepareHtml(html);
  let limit = prepared.limit;
  if (!limit) {
    try {
      const text = makeTurndown(prepared.textChars).turndown(prepared.markup)
        .split("\n").map(line => line.trimEnd()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
      if (text.length > HTML_FORMAT_CHARS) throw new HtmlFormatLimit("output");
      return { text, title: prepared.title };
    } catch (error) {
      if (!(error instanceof HtmlFormatLimit)) throw error;
      limit = error.limit;
    }
  }
  const descriptions: Record<FormatLimit, string> = {
    depth: `depth (${HTML_FORMAT_DEPTH})`,
    nodes: `node count (${HTML_FORMAT_NODES})`,
    quotes: `quotation depth (${HTML_QUOTE_DEPTH})`,
    table: `table width or nesting (${HTML_TABLE_COLUMNS} columns, ${HTML_TABLE_DEPTH} levels)`,
    size: `source size (${HTML_FORMAT_CHARS} characters)`,
    output: `output size (${HTML_FORMAT_CHARS} characters)`,
  };
  const { text, cut } = readBoundedHtmlText(html, DROP_ELEMENTS, HTML_FORMAT_CHARS);
  warnings.push(`HTML exceeded the formatting limit for ${descriptions[limit]}. Showing plain text with formatting omitted.`);
  if (cut) warnings.push(`HTML plain text was truncated at ${HTML_FORMAT_CHARS} characters.`);
  return { title: prepared.title, text };
}
