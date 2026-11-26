import { Parser } from "htmlparser2";
import TurndownService from "turndown";
import type { FragmentBudget } from "./fragment-budget.js";
import { HTML_PARSER_DEPTH, readBoundedHtmlText } from "./html-plain-text.js";

/**
 * HTML → light markdown for saved pages, EPUB chapters and mail bodies.
 * The HTML parser prepares bounded markup before Turndown builds a DOM.
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
const PARAGRAPH_CLOSERS = new Set([
  "address", "article", "aside", "blockquote", "dd", "details", "dialog", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hgroup", "hr", "li", "listing", "main", "menu", "nav", "ol", "p", "plaintext",
  "pre", "search", "section", "summary", "table", "ul", "xmp",
]);
const INLINE_ELEMENTS = new Set([
  "abbr", "acronym", "b", "bdi", "bdo", "big", "cite", "code", "del", "dfn", "em", "i",
  "ins", "kbd", "label", "mark", "q", "s", "samp", "small", "span", "strike", "strong",
  "sub", "sup", "time", "tt", "u", "var",
]);
const HTML_SOURCE_CHARS = 768 * 1024;
const HTML_OUTPUT_CHARS = 576 * 1024;
const HTML_PLAIN_CHARS = 384 * 1024;
const HTML_FORMAT_DEPTH = 128;
const HTML_FORMAT_NODES = 30_000;
const HTML_WHITESPACE_RUN = 128;
const HTML_QUOTE_DEPTH = 32;
const HTML_TABLE_DEPTH = 64;
const HTML_TABLE_COLUMNS = 64;
const TABLE_LAYOUT_TAGS = new Set(["table", "thead", "tbody", "tfoot", "tr", "td", "th", "colgroup", "col"]);
const HTML_TITLE_CHARS = 1_024;
const HTML_ATTRIBUTE_BYTES = 2_048;
const HTML_TAG = /^[a-z][a-z0-9:-]*$/i;
const ATTRIBUTES = new Map([
  ["a", ["href", "title"]],
  ["img", ["src", "alt", "title"]],
  ["ol", ["start"]],
  ["td", ["colspan"]],
  ["th", ["colspan"]],
]);

type FormatLimit = "size" | "depth" | "nodes" | "output";

class HtmlFormatLimit extends Error {
  constructor(readonly limit: FormatLimit) { super(limit); }
}

// Turndown uses its own DOM implementation on Node.js. The production
// tsconfig intentionally does not include browser DOM types.
interface MarkdownNode {
  readonly nodeName: string;
  readonly nodeType: number;
  readonly nodeValue: string | null;
  readonly parentNode: MarkdownNode | null;
  readonly childNodes: ArrayLike<MarkdownNode>;
  readonly isCode?: boolean;
  readonly flankingWhitespace: { leading: string; trailing: string };
}

function parentTable(node: object): MarkdownNode | undefined {
  for (let parent = (node as MarkdownNode).parentNode; parent; parent = parent.parentNode) {
    if (parent.nodeName === "TABLE") return parent;
  }
  return undefined;
}

function columnSpan(node: object): number {
  return Number(attribute(node, "colspan") ?? 1);
}

function rowWidth(row: MarkdownNode): number {
  let width = 0;
  for (const cell of Array.from(row.childNodes)) {
    if (cell.nodeName === "TD" || cell.nodeName === "TH") width += columnSpan(cell);
  }
  return width;
}

function outerRowWidth(table: MarkdownNode): number {
  let width = 0;
  for (const child of Array.from(table.childNodes)) {
    if (child.nodeName === "TR") {
      width = Math.max(width, rowWidth(child));
    } else if (child.nodeName === "THEAD" || child.nodeName === "TBODY" || child.nodeName === "TFOOT") {
      width = Math.max(width, outerRowWidth(child));
    }
  }
  return width;
}

function attribute(node: object, name: string): string | null {
  return (node as { getAttribute(name: string): string | null }).getAttribute(name);
}

function makeTurndown(flattenWideTable: () => void): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  // Record each table's width before its children render. No cell or row
  // needs to rescan the table, and wide tables never build pipe grids.
  const widths = new WeakMap<object, number>();
  const widthOfParent = (node: object) => {
    const table = parentTable(node);
    return table ? (widths.get(table) ?? 0) : 0;
  };
  const cellRule: TurndownService.Rule = {
    filter: ["th", "td"],
    replacement: (content, node) => {
      const text = content.replace(/\n/g, " ").replace(/ {2,}/g, " ").trim();
      const width = widthOfParent(node);
      if (!width || width > HTML_TABLE_COLUMNS) return ` ${text}`;
      // A pipe needs an odd number of preceding backslashes to stay in
      // its cell. Preserve runs that already escape the pipe.
      const escaped = text.replace(/(?<!\\)((?:\\\\)*)\|/g, "$1\\|");
      return ` ${escaped} |${"  |".repeat(columnSpan(node) - 1)}`;
    },
  };
  const rowRule: TurndownService.Rule = {
    filter: "tr",
    replacement: (content, node) => {
      const columns = widthOfParent(node);
      if (!columns || columns > HTML_TABLE_COLUMNS) return `\n${content.trim()}\n`;
      const missing = Math.max(0, columns - rowWidth(node as unknown as MarkdownNode));
      return `\n|${content}${"  |".repeat(missing)}`;
    },
  };
  td.addRule("tableSection", {
    filter: ["thead", "tbody", "tfoot"],
    replacement: (content) => content,
  });
  const tableRule: TurndownService.Rule = {
    filter: "table",
    replacement: (content, node) => {
      const columns = widths.get(node) ?? 0;
      if (columns > HTML_TABLE_COLUMNS) {
        flattenWideTable();
        return `\n\n${content.trim()}\n\n`;
      }
      const rows = content
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("|"));
      if (rows.length === 0 || columns === 0) return "\n\n";
      const separator = `|${" --- |".repeat(columns)}`;
      return `\n\n${[rows[0], separator, ...rows.slice(1)].join("\n")}\n\n`;
    },
  };
  const tableRules = new Map([["TD", cellRule], ["TH", cellRule], ["TR", rowRule], ["TABLE", tableRule]]);
  const escape = td.escape.bind(td);
  td.remove(["button", "input", "select", "textarea"]);
  td.addRule("imageWithoutUrl", {
    filter: node => (node as unknown as MarkdownNode).nodeName === "IMG" && !attribute(node, "src"),
    replacement: (_content, node) => escape(normalizeLabel(attribute(node, "alt") ?? "")),
  });
  let spent = 0;
  const charge = (amount: number) => {
    spent += amount;
    if (spent > HTML_OUTPUT_CHARS) throw new HtmlFormatLimit("output");
  };
  // Turndown collapses whitespace before passing text here. Count its
  // escaped text instead of charging source indentation as output.
  td.escape = (text) => {
    const result = escape(text);
    charge(result.length);
    return result;
  };
  // Turndown resolves each rule before recursing into its children. Wrap
  // replacements per conversion so intermediate growth is charged too.
  const { rules } = td;
  const ruleFor = rules.forNode.bind(rules);
  rules.forNode = (node) => {
    const element = node as unknown as MarkdownNode;
    if (element.nodeName === "TABLE") widths.set(element, outerRowWidth(element));
    // Text within <code> bypasses Turndown's escape hook.
    if (element.isCode) {
      for (const child of Array.from(element.childNodes)) {
        if (child.nodeType === 3) charge(child.nodeValue?.length ?? 0);
      }
    }
    // Empty cells also need a delimiter. Turndown's blank rule would omit it.
    const rule = tableRules.get(element.nodeName) ?? ruleFor(node);
    const replace = rule.replacement;
    if (!replace) return rule;
    return { ...rule, replacement(content, target, options) {
      const result = replace.call(rule, content, target, options);
      const { leading, trailing } = element.flankingWhitespace;
      charge(leading.length + trailing.length + Math.max(0, result.length - content.length));
      return result;
    } };
  };
  return td;
}

export interface HtmlMarkdown {
  text: string;
  title?: string;
}

function escapeMarkup(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function usableUrlAttribute(value: string | undefined): value is string {
  return Boolean(value && Buffer.byteLength(value, "utf8") <= HTML_ATTRIBUTE_BYTES &&
    !/^data:/i.test(value.replace(/[\t\r\n]/g, "").trim()));
}

function normalizeLabel(value: string): string {
  return value.replace(/[\s\u0085]+/gu, " ").trim();
}

function openingTag(name: string, attributes: Record<string, string>): string {
  let result = `<${name}`;
  for (const field of ATTRIBUTES.get(name) ?? []) {
    const raw = attributes[field];
    if (!raw) continue;
    const value = field === "alt" || field === "title" ? normalizeLabel(raw) : raw;
    if (!value) continue;
    const oversize = Buffer.byteLength(value, "utf8") > HTML_ATTRIBUTE_BYTES;
    if (field === "href" || field === "src") {
      // With no URL, an anchor retains its text and an image keeps its alt.
      if (!usableUrlAttribute(value)) continue;
    }
    if (field === "start" && !/^-?\d{1,8}$/.test(value)) continue;
    if (field === "colspan" && !/^[1-9]\d{0,3}$/.test(value)) continue;
    const bounded = oversize ? value.slice(0, HTML_ATTRIBUTE_BYTES / 4) : value;
    result += ` ${field}="${escapeMarkup(bounded).replaceAll('"', "&quot;")}"`;
  }
  return result + ">";
}

/**
 * Strip non-visible markup and check the depth before giving any parser
 * that builds a DOM or renders recursively a bounded fragment.
 */
function prepareHtml(html: string, recognizeSelfClosing: boolean) {
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
  let whitespaceRun = 0;
  let inText = false;
  let renderedDepth = 0;
  let openAnchor = -1;
  let openAnchorMarkup = -1;
  let openParagraph = -1;
  const emitted: Array<string | undefined> = [];
  const flattened = { depth: false, quotes: false, tables: false };

  const stop = (reason: FormatLimit) => {
    limit = reason;
    parser.pause();
  };
  const append = (text: string, cost = text.length) => {
    if (cost > HTML_SOURCE_CHARS - length) return stop("size");
    parts.push(text);
    length += cost;
  };
  const closeTag = (tag: string) => {
    if (tag === "a") {
      openAnchor = -1;
      openAnchorMarkup = -1;
    }
    if (tag === "p") openParagraph = -1;
    renderedDepth--;
    append(`</${tag}>`);
  };
  const closeEmittedFrom = (index: number) => {
    for (let i = emitted.length - 2; i >= index && !limit; i--) {
      const tag = emitted[i];
      if (!tag) continue;
      closeTag(tag);
      emitted[i] = undefined;
    }
  };
  const closeOpenAnchor = () => {
    for (let i = emitted.length - 2; i > openAnchor; i--) {
      const tag = emitted[i];
      if (tag && !INLINE_ELEMENTS.has(tag)) {
        // An overlapping anchor is invalid. Unwrap the outer link
        // so its blocks remain open around the inner link.
        parts[openAnchorMarkup] = "";
        emitted[openAnchor] = undefined;
        openAnchor = -1;
        openAnchorMarkup = -1;
        renderedDepth--;
        return;
      }
    }
    closeEmittedFrom(openAnchor);
  };
  // The parser can deliver a single run in several callbacks, especially
  // across entity references. Tags do not reset it; visible text does.
  const whitespace = /[\s\u0085]/u;
  const textRuns = /[\s\u0085]+|[^\s\u0085]+/gu;
  const limitWhitespace = (text: string): string => {
    if (text.length === 1) {
      if (!whitespace.test(text)) {
        whitespaceRun = 0;
        return text;
      }
      if (whitespaceRun === HTML_WHITESPACE_RUN) return "";
      whitespaceRun++;
      return text;
    }
    const chunks: string[] = [];
    textRuns.lastIndex = 0;
    for (let match = textRuns.exec(text); match; match = textRuns.exec(text)) {
      const run = match[0];
      if (!whitespace.test(run[0]!)) {
        whitespaceRun = 0;
        chunks.push(run);
        continue;
      }
      const allowed = Math.min(run.length, HTML_WHITESPACE_RUN - whitespaceRun);
      if (allowed > 0) {
        whitespaceRun += allowed;
        chunks.push(run.slice(0, allowed));
      }
    }
    return chunks.join("");
  };
  const parser: Parser = new Parser({
    onopentag(name, attributes) {
      if (limit) return;
      inText = false;
      depth++;
      if (!VOID_ELEMENTS.has(name) && depth > HTML_PARSER_DEPTH) return stop("depth");
      if (name === "blockquote") quotes++;
      if (name === "table") tables++;
      if (name === "title" && rawTitle === undefined) {
        titleDepth = depth;
        rawTitle = "";
      }
      if (!omittedDepth && (name === "title" || DROP_ELEMENTS.has(name))) omittedDepth = depth;
      emitted.push(undefined);
      if (omittedDepth || !HTML_TAG.test(name)) return;
      if (!recognizeSelfClosing) {
        // The parser can leave a paragraph on its stack when an inline
        // wrapper intervenes. Serialize its implicit HTML closing tag.
        if (openParagraph >= 0 && PARAGRAPH_CLOSERS.has(name)) closeEmittedFrom(openParagraph);
        if (openAnchor >= 0 && name === "a") closeOpenAnchor();
      }
      if (limit) return;
      // Font and unstyled spans carry no structure in Markdown. Named
      // anchors still close a previous link but do not wrap following text.
      if (name === "font") {
        flattened.depth ||= openParagraph < 0 && depth > HTML_FORMAT_DEPTH;
        return;
      }
      if (!recognizeSelfClosing &&
          (name === "span" || (name === "a" && !usableUrlAttribute(attributes.href)))) return;
      if (name === "br") {
        if (whitespaceRun >= HTML_WHITESPACE_RUN) return;
        whitespaceRun++;
      }
      if (++nodes > HTML_FORMAT_NODES) return stop("nodes");
      if (name === "blockquote" && quotes > HTML_QUOTE_DEPTH) {
        flattened.quotes = true;
        return;
      }
      // Keep nested layout in its outer cell without emitting nested grids
      // or stripping the links and headings inside those cells.
      if (tables > 1 && TABLE_LAYOUT_TAGS.has(name)) {
        if (tables > HTML_TABLE_DEPTH) flattened.tables = true;
        if (name === "td" || name === "th" || name === "tr") append(" ");
        return;
      }
      const isVoid = VOID_ELEMENTS.has(name);
      if (!isVoid && renderedDepth >= HTML_FORMAT_DEPTH) {
        flattened.depth = true;
        return;
      }
      if (!isVoid) {
        renderedDepth++;
        emitted[emitted.length - 1] = name;
        if (name === "a" && !recognizeSelfClosing) {
          openAnchor = emitted.length - 1;
          openAnchorMarkup = parts.length;
        }
        if (name === "p" && !recognizeSelfClosing) openParagraph = emitted.length - 1;
      }
      append(openingTag(name, attributes));
    },
    onclosetag(name) {
      if (limit) return;
      inText = false;
      if (titleDepth === depth) titleDepth = 0;
      if (omittedDepth === depth) omittedDepth = 0;
      const tag = emitted.pop();
      if (tag) {
        closeTag(tag);
      } else if (!omittedDepth && tables > 1 && (name === "td" || name === "th" || name === "tr")) {
        append(" ");
      }
      if (name === "blockquote") quotes--;
      if (name === "table") tables--;
      depth--;
    },
    ontext(text) {
      if (limit) return;
      if (titleDepth) rawTitle += text.slice(0, HTML_TITLE_CHARS - (rawTitle?.length ?? 0));
      if (!omittedDepth) {
        const bounded = limitWhitespace(text);
        if (!bounded) return;
        if (!inText && /[^\s\u0085]/u.test(bounded)) {
          if (++nodes > HTML_FORMAT_NODES) return stop("nodes");
          inText = true;
        }
        if (bounded.length > HTML_SOURCE_CHARS - length) return stop("size");
        append(escapeMarkup(bounded), bounded.length);
      }
    },
  }, { decodeEntities: true, recognizeSelfClosing });
  parser.end(html);
  const title = rawTitle?.trim() || undefined;
  return { markup: parts.join(""), title, limit, flattened, nodes };
}

function isXhtml(html: string): boolean {
  const intro = html.slice(0, 8_192);
  return /^\s*<\?xml(?:\s|\?)/i.test(intro)
    || /<html\b[^>]*\sxmlns\s*=\s*["']http:\/\/www\.w3\.org\/1999\/xhtml["']/i.test(intro);
}

export function boundedHtmlToMarkdown(
  html: string,
  warnings: string[],
  xhtml = isXhtml(html),
  budget?: FragmentBudget,
): HtmlMarkdown {
  const prepared = prepareHtml(html, xhtml);
  // Short tags still require DOM allocation and traversal. Charge both
  // markup and nodes before starting a conversion in a document container.
  const work = prepared.markup.length + 16 * prepared.nodes;
  if (budget && !budget.takeWork(work)) return { text: "" };
  let limit = prepared.limit;
  if (!limit) {
    try {
      let wideTable = false;
      const text = makeTurndown(() => { wideTable = true; }).turndown(prepared.markup)
        .split("\n").map(line => line.trimEnd()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
      if (text.length > HTML_OUTPUT_CHARS) throw new HtmlFormatLimit("output");
      if (budget && !budget.takeWork(Math.max(0, text.length - work))) return { text: "" };
      if (prepared.flattened.depth) warnings.push(`HTML structure beyond depth ${HTML_FORMAT_DEPTH} was flattened locally.`);
      if (prepared.flattened.quotes) warnings.push(`HTML quotations beyond ${HTML_QUOTE_DEPTH} levels were flattened locally.`);
      if (prepared.flattened.tables) warnings.push(`HTML table nesting beyond ${HTML_TABLE_DEPTH} levels was flattened in its outer cell.`);
      if (wideTable) warnings.push(`HTML table width exceeded ${HTML_TABLE_COLUMNS} columns. Only the wide table was flattened.`);
      return { text, title: prepared.title };
    } catch (error) {
      if (!(error instanceof HtmlFormatLimit)) throw error;
      limit = error.limit;
    }
  }
  const descriptions: Record<FormatLimit, string> = {
    depth: `depth (${HTML_PARSER_DEPTH})`,
    nodes: `node count (${HTML_FORMAT_NODES})`,
    size: `source size (${HTML_SOURCE_CHARS} characters)`,
    output: `output size (${HTML_OUTPUT_CHARS} characters)`,
  };
  if (budget && !budget.takeWork(Math.min(html.length, HTML_PLAIN_CHARS))) return { text: "" };
  const { text, cut } = readBoundedHtmlText(html, DROP_ELEMENTS, HTML_PLAIN_CHARS);
  warnings.push(`HTML exceeded the formatting limit for ${descriptions[limit]}. Showing plain text with formatting omitted.`);
  if (cut) warnings.push(`HTML plain text was truncated at ${HTML_PLAIN_CHARS} characters.`);
  return { title: prepared.title, text };
}
