import { parseHTML } from "linkedom";
import { Parser } from "htmlparser2";
import TurndownService from "turndown";
import { convert as htmlToText } from "html-to-text";

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
const DROP_SELECTOR = [...DROP_ELEMENTS].join(",");

let turndown: TurndownService | null = null;

function getTurndown(): TurndownService {
  if (turndown) return turndown;
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
    replacement: (content) => ` ${content.replace(/\s+/g, run => run.includes("\n") ? " " : run).trim()} |`,
  });
  td.addRule("tableRow", {
    filter: "tr",
    replacement: (content) => `\n|${content}`,
  });
  td.addRule("tableSection", {
    filter: ["thead", "tbody", "tfoot"],
    replacement: (content) => content,
  });
  td.addRule("table", {
    filter: "table",
    replacement: (content) => {
      const rows = content
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("|"));
      if (rows.length === 0) return "\n\n";
      const columns = Math.max(1, (rows[0]!.match(/\|/g)?.length ?? 2) - 1);
      const separator = `|${" --- |".repeat(columns)}`;
      return `\n\n${[rows[0], separator, ...rows.slice(1)].join("\n")}\n\n`;
    },
  });
  td.remove(["button", "input", "select", "textarea"]);
  turndown = td;
  return td;
}

export interface HtmlMarkdown {
  text: string;
  title?: string;
}

const HTML_FORMAT_CHARS = 384 * 1024;
const HTML_FORMAT_DEPTH = 1_000;
const HTML_TITLE_CHARS = 1_024;

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
  let limit: "size" | "depth" | undefined;

  const stop = (reason: "size" | "depth") => {
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
      if (++depth > HTML_FORMAT_DEPTH) return stop("depth");
      if (name === "title" && rawTitle === undefined) {
        titleDepth = depth;
        rawTitle = "";
      }
      if (!omittedDepth && (name === "title" || DROP_ELEMENTS.has(name))) omittedDepth = depth;
      if (!omittedDepth && !implied) appendTag();
    },
    onclosetag(_name, implied) {
      if (limit) return;
      if (titleDepth === depth) titleDepth = 0;
      if (omittedDepth === depth) omittedDepth = 0;
      else if (!omittedDepth && !implied) appendTag();
      depth--;
    },
    ontext(text) {
      if (limit) return;
      if (titleDepth) rawTitle += text.slice(0, HTML_TITLE_CHARS - (rawTitle?.length ?? 0));
      if (!omittedDepth) append(text, true);
    },
  }, { decodeEntities: false });
  parser.end(html);
  const title = rawTitle
    ? parseHTML(`<html><head><title>${rawTitle}</title></head><body></body></html>`)
      .document.querySelector("title")?.textContent?.trim() || undefined
    : undefined;
  return { markup: parts.join(""), title, limit };
}

export function boundedHtmlToMarkdown(html: string, warnings: string[]): HtmlMarkdown {
  const { markup, title, limit } = prepareHtml(html);
  if (!limit) return { ...htmlToMarkdown(markup), title };
  if (limit === "depth") {
    warnings.push(`HTML exceeded the depth limit of ${HTML_FORMAT_DEPTH}; some content was omitted. Showing plain text.`);
  } else {
    warnings.push(`HTML was truncated at ${HTML_FORMAT_CHARS} characters of visible markup; some content may have been omitted. Showing plain text.`);
  }
  return { title, text: htmlToText(markup, {
    wordwrap: false,
    limits: { maxDepth: 128 },
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
    ],
  }).trim() };
}

export function htmlToMarkdown(html: string): HtmlMarkdown {
  // linkedom does not synthesise <html>/<body> around a fragment the way a
  // browser does (the first element becomes the document element), so a
  // bare `<table>…` or a mail body without a wrapper is wrapped first.
  const wrapped = /<body[\s>]/i.test(html) ? html : `<!doctype html><html><head></head><body>${html}</body></html>`;
  const { document } = parseHTML(wrapped);
  const title = document.querySelector("title")?.textContent?.trim() || undefined;
  for (const node of Array.from(document.querySelectorAll(DROP_SELECTOR))) {
    (node as { remove(): void }).remove();
  }
  const body = document.body as { innerHTML?: string } | null;
  const source =
    body?.innerHTML && body.innerHTML.trim().length > 0
      ? body.innerHTML
      : (document.documentElement as { innerHTML?: string } | null)?.innerHTML ?? "";
  const markdown = getTurndown()
    .turndown(source)
    .replace(/[ \t]+(\n)?/g, (run, newline: string | undefined) => newline ?? run)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: markdown, title };
}
