import { parseHTML } from "linkedom";
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
const DROP_SELECTOR = [
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
].join(",");

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
    replacement: (content) => ` ${content.replace(/\s*\n+\s*/g, " ").trim()} |`,
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

const HTML_FORMAT_CHARS = 64 * 1024;
const HTML_FORMAT_TAG_STARTS = 256;

/** Keep recursive Markdown conversion on small, structurally simple input. */
export function boundedHtmlToMarkdown(html: string, warnings: string[]): HtmlMarkdown {
  const prefix = html.slice(0, HTML_FORMAT_CHARS);
  if (prefix.length < html.length) {
    warnings.push(`HTML was truncated to ${HTML_FORMAT_CHARS} characters before text extraction`);
  } else {
    let offset = -1;
    for (let tags = 0; tags <= HTML_FORMAT_TAG_STARTS; tags++) {
      offset = prefix.indexOf("<", offset + 1);
      if (offset < 0) return htmlToMarkdown(prefix);
    }
    warnings.push("HTML formatting exceeded the conversion budget; showing plain text");
  }
  return { text: htmlToText(prefix, {
    wordwrap: false,
    limits: { maxDepth: 32, maxChildNodes: 256 },
    selectors: [
      { selector: "head", format: "skip" },
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" },
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
