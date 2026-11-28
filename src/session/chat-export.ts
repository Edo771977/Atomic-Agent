import { Lexer, Marked, type Token, type Tokens } from "marked";
import { decodeHTML } from "entities";

import {
  knownSecretsFromEnv,
  maskSecrets,
  MIN_KNOWN_SECRET_LENGTH,
  redactedMarker,
  type KnownSecret,
} from "../error-reporting/secret-detector.js";

import type { ConversationTurn } from "./conversation-turn.js";
import type { SessionState } from "./session-state.js";
import { readSessionTitle } from "./session-title.js";

/**
 * Export one chat as a document (ATO-1054): Markdown first, and HTML /
 * DOCX / PDF built from that Markdown so every format says the same thing.
 *
 * What goes in is what the person saw: their messages, the agent's
 * replies (progress notes included), one line per tool step, and the
 * files a reply delivered. Reasoning blocks, raw tool output and the
 * prompt-only state (loaded skills, facts, snapshots) stay out: they are
 * the agent's working memory, not the conversation, and raw tool output
 * can be megabytes of file content the person never read.
 *
 * An export is a file meant to leave the agent, so every line of it (the
 * title, messages, tool-step lines such as a `curl -H "Authorization:
 * Bearer …"` command) goes through the shared credential detector
 * (`maskSecrets`, error-reporting) before it is written.
 */

export type ChatExportFormat = "markdown" | "html" | "docx" | "pdf";

/** The formats a caller may name, with the short spellings people type. */
export function parseChatExportFormat(raw: string | null | undefined): ChatExportFormat | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "" || v === "md" || v === "markdown") return "markdown";
  if (v === "html" || v === "htm") return "html";
  if (v === "docx" || v === "word") return "docx";
  if (v === "pdf") return "pdf";
  return null;
}

export const CHAT_EXPORT_MIME: Record<ChatExportFormat, string> = {
  markdown: "text/markdown; charset=utf-8",
  html: "text/html; charset=utf-8",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
};

const EXTENSION: Record<ChatExportFormat, string> = { markdown: "md", html: "html", docx: "docx", pdf: "pdf" };

/** A tool step in words, as the live stream labels it once done. */
export type DescribeExportedToolCall = (call: {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
}) => string;

export interface ChatExportOptions {
  /** One line per tool step. Default true. */
  includeTools?: boolean;
  /** Words for a tool step; without it the line names the tool. */
  describeToolCall?: DescribeExportedToolCall;
  /** Export time for the header. Default `Date.now()`. */
  now?: number;
  /**
   * Exact values to mask besides the detector's shapes. Default: the
   * secret-named variables of `process.env` (which carries the agent's `.env`).
   */
  knownSecrets?: readonly KnownSecret[];
}

/** `text` with every credential the shared detector finds replaced by a marker. */
function maskPresentationText(text: string, known: readonly KnownSecret[]): string {
  text = maskSecrets(text, known);
  // Match a conservative presentation projection while replacing the original
  // source range: Markdown delimiters/escapes, invisible/control characters and
  // compatibility forms must not hide a key until a renderer joins its pieces.
  const project = projectPresentationText;
  const needles = known.map(secret => project(secret.value)).filter(value => value.length >= MIN_KNOWN_SECRET_LENGTH);
  if (needles.length === 0) return text;
  const candidate = project(text);
  if (!needles.some(needle => candidate.includes(needle))) return text;
  let projected = "";
  const starts: number[] = [];
  const ends: number[] = [];
  for (const unit of text.matchAll(/&(?:amp;)*(?:#(?:x[\da-f]+|\d+);?|[a-z][\da-z]+;)|[\s\S]/giu)) {
    const value = project(unit[0]);
    for (let i = 0; i < value.length; i += 1) { starts.push(unit.index!); ends.push(unit.index! + unit[0].length); }
    projected += value;
  }
  const ranges: Array<[number, number]> = [];
  for (const needle of new Set(needles)) {
    for (let at = projected.indexOf(needle); at >= 0; at = projected.indexOf(needle, at + needle.length)) {
      ranges.push([starts[at]!, ends[at + needle.length - 1]!]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let out = "";
  let consumed = 0;
  for (const [start, end] of ranges) {
    if (end <= consumed) continue;
    out += text.slice(consumed, Math.max(consumed, start)) + redactedMarker("secret");
    consumed = end;
  }
  const masked = maskSecrets(out + text.slice(consumed), known);
  return needles.some(needle => project(masked).includes(needle)) ? redactedMarker("secret") : masked;
}

function projectPresentationText(value: string): string {
  return decodeReferences(value).replace(/\u00a0/g, "").normalize("NFKD")
    .replace(/[\p{M}\p{Default_Ignorable_Code_Point}\p{Cc}*_`~\\]/gu, "");
}

/** Decode references for matching only; the original source offsets stay intact. */
function decodeReferences(text: string): string {
  for (let depth = 0; depth < 4 && text.includes("&"); depth += 1) {
    const decoded = decodeHTML(text);
    if (decoded === text) break;
    text = decoded;
  }
  return text;
}

/** Text a renderer joins, including nested emphasis and link labels, excluding URLs. */
function inlineText(tokens: readonly Token[]): string {
  return tokens.map(token => {
    if (token.type === "list") return (token as Tokens.List).items.map(item => inlineText(item.tokens)).join("\n");
    if (token.type === "table") {
      const table = token as Tokens.Table;
      return [table.header, ...table.rows].map(row => row.map(cell => inlineText(cell.tokens)).join("")).join("\n");
    }
    if ("tokens" in token && Array.isArray(token.tokens)) return inlineText(token.tokens);
    if (token.type === "br") return "";
    return "text" in token && typeof token.text === "string" ? decodeReferences(token.text) : "";
  }).join("");
}

/** Column-zero fences close list context; inner runs cannot close this fence. */
function literalMarkdownBlock(block: string): string {
  const closed = block.replace(/\n+$/, "");
  const firstBreak = closed.indexOf("\n"), lastBreak = closed.lastIndexOf("\n");
  const opening = closed.slice(0, firstBreak);
  if (firstBreak >= 3 && lastBreak > firstBreak && /^`+$/.test(opening)
    && closed.slice(lastBreak + 1) === opening) {
    const body = closed.slice(firstBreak + 1, lastBreak);
    let longestBodyRun = 0;
    for (const run of body.matchAll(/`+/g)) longestBodyRun = Math.max(longestBodyRun, run[0].length);
    if (longestBodyRun < opening.length) return block;
  }
  let longest = 2;
  for (const run of block.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  const fence = "`".repeat(longest + 1);
  return `\n\n${fence}\n${block}\n${fence}\n\n`;
}

type ExportBlockContext = { kind: "fence"; marker: string; length: number }
  | { kind: "html"; end: RegExp };

function openExportBlock(line: string): ExportBlockContext | undefined {
  const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (fence && (fence[1]![0] === "~" || !fence[2]!.includes("`"))) {
    return { kind: "fence", marker: fence[1]![0]!, length: fence[1]!.length };
  }
  const tag = /^ {0,3}<(script|pre|style|textarea)(?:\s|>|$)/i.exec(line);
  if (tag) return { kind: "html", end: new RegExp(`</${tag[1]!}>`, "i") };
  if (/^ {0,3}<!--/.test(line)) return { kind: "html", end: /-->/ };
  if (/^ {0,3}<\?/.test(line)) return { kind: "html", end: /\?>/ };
  if (/^ {0,3}<![a-z]/i.test(line)) return { kind: "html", end: />/ };
  if (/^ {0,3}<!\[CDATA\[/i.test(line)) return { kind: "html", end: /\]\]>/ };
  return undefined;
}

/** Blank lines cannot split HTML types 1–5 or a backtick/tilde fence. */
function exportMarkdownBlocks(text: string): string[] {
  const blocks: string[] = [];
  let start = 0;
  let context: ExportBlockContext | undefined;
  for (const match of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    const raw = match[0];
    if (!raw) continue;
    const at = match.index!, end = at + raw.length;
    const line = raw.replace(/\r?\n$/, "");
    if (context) {
      const fence = context.kind === "fence" ? /^ {0,3}(`+|~+)[\t ]*$/.exec(line) : null;
      const closes = context.kind === "html" ? context.end.test(line)
        : !!fence && fence[1]![0] === context.marker && fence[1]!.length >= context.length;
      if (closes) context = undefined;
      continue;
    }
    context = openExportBlock(line);
    if (context) {
      if (context.kind === "html" && context.end.test(line)) context = undefined;
    } else if (/^[\t ]*$/.test(line)) {
      if (start < at) blocks.push(text.slice(start, at));
      blocks.push(raw); start = end;
    }
  }
  if (start < text.length) blocks.push(text.slice(start));
  return blocks;
}

/** Mask both source forms and the inline presentation of each parsed block. */
export function maskChatExportText(text: string, options: ChatExportOptions = {}): string {
  const known = options.knownSecrets ?? knownSecretsFromEnv();
  // Plain printable ASCII has no presentation transform to project. Controls
  // stay on the slow path because document encoders can remove them.
  if (/^[\x20-\x7e]*$/.test(text) && !/[*_`~&\[\\<|]/.test(text)) return maskSecrets(text, known);
  text = maskPresentationText(text, known);
  if (!/[*_`~&\[\\<|]| {2}\r?\n/.test(text)) return text;
  const needles = known.map(secret => projectPresentationText(secret.value)).filter(value => value.length >= MIN_KNOWN_SECRET_LENGTH);
  let parserWorkLeft = 32_768;
  return exportMarkdownBlocks(text).map(block => {
    if (!/[*_`~&\[\\<|]| {2}\r?\n/.test(block)) return block;
    const projected = projectPresentationText(block);
    const possibleKey = () => needles.some(needle => {
      let at = 0;
      for (let i = 0; i < projected.length; i += 1) if (projected[i] === needle[at] && ++at === needle.length) return true;
      return false;
    });
    // A reference label can be resolved by a definition in another block. Do
    // not require document-wide lexing to detect that join: fail closed on a
    // possible key subsequence in linked markup, regardless of reference scope.
    if (block.includes("[")) {
      const labels = projected.replace(/\]\[[^\]\r\n]*\]/g, "]").replace(/[\[\]]/g, "");
      if (possibleKey() || maskSecrets(labels, known) !== labels) return redactedMarker("complex-markdown");
    }
    if (block.length > 2_048 || block.length > parserWorkLeft) {
      if (possibleKey() || maskSecrets(projected, known) !== projected) return redactedMarker("complex-markdown");
      // Literal code cannot join inline nodes, and keeps adversarial markup out
      // of the document renderer's inline parser as well as our own parser.
      return literalMarkdownBlock(block);
    }
    // Source projection already handles delimiter/entity-only known values.
    // Code spans trim boundary spaces; breaks and cells can join visible text.
    // Their presentation cannot be ruled out by the source-only projection.
    if (!/[\[`\\|]| {2}\r?\n/.test(block) && maskSecrets(projected, known) === projected) return block;
    parserWorkLeft -= block.length;
    return Lexer.lex(block).map(token => {
      const shown = inlineText([token]);
      const masked = maskPresentationText(shown, known);
      return masked === shown ? token.raw : masked + (/\n*$/.exec(token.raw)?.[0] ?? "");
    }).join("");
  }).join("");
}

/** The chat's name: its title, else its first prompt cut short, else its id. */
export function chatExportTitle(state: SessionState, options: ChatExportOptions = {}): string {
  const title = readSessionTitle(state.metadata);
  if (title) return maskChatExportText(title, options);
  const first = state.turns.find((t) => t.kind === "user" && t.text.trim().length > 0);
  if (first && first.kind === "user") {
    // Mask before cutting short, so a cut cannot leave half a key unmatched.
    const line = maskChatExportText(first.text.trim().split(/\r?\n/, 1)[0] ?? "", options);
    // Cut by code points, so an emoji is never split into half a pair.
    const chars = Array.from(line);
    return chars.length > 60 ? `${chars.slice(0, 57).join("").trimEnd()}...` : line;
  }
  return `Chat ${state.id}`;
}

/** Names Windows keeps for devices, with or without an extension. */
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/**
 * A file name for the export: the title with anything a file system or
 * a shell would trip on replaced, never empty, never over 80 characters
 * (code points, so no half of a surrogate pair), never a Windows device
 * name (`CON`, `nul.txt`, `COM1`: prefixed with `chat-`), and never
 * ending in a dot, which Windows drops.
 */
export function chatExportFilename(
  state: SessionState,
  format: ChatExportFormat,
  options: ChatExportOptions = {},
): string {
  const base = chatExportTitle(state, options)
    .normalize("NFKC")
    // Path separators, reserved Windows characters, control characters.
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  const cut = Array.from(base).slice(0, 80).join("").replace(/[\s.]+$/, "");
  const name = WINDOWS_DEVICE_NAME.test(cut) ? `chat-${cut}` : cut;
  return `${name || `chat-${state.id}`}.${EXTENSION[format]}`;
}

/** `2026-11-12 14:03 UTC`: the same text on every machine. */
function stamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

type ToolCallTurn = Extract<ConversationTurn, { kind: "assistant_tool_call" }>;

/**
 * Whether the call at `index` failed. Calls and results pair by position
 * within one user turn: the n-th call of a tool goes with the n-th result
 * of that tool, so a parallel batch (call, call, ok, error) marks the
 * second call, not the first.
 */
function callFailed(turns: readonly ConversationTurn[], index: number, call: ToolCallTurn): boolean {
  let from = index;
  while (from > 0 && turns[from - 1]?.kind !== "user") from -= 1;
  let nth = 0;
  for (let i = from; i < index; i += 1) {
    const t = turns[i];
    if (t?.kind === "assistant_tool_call" && t.tool === call.tool) nth += 1;
  }
  let seen = 0;
  for (let i = from; i < turns.length; i += 1) {
    const t = turns[i];
    if (!t || (t.kind === "user" && i > index)) return false;
    if (t.kind === "tool_result" && t.tool === call.tool) {
      if (seen === nth) return t.status === "error";
      seen += 1;
    }
  }
  return false;
}

/** The chat as Markdown. */
export function renderChatMarkdown(state: SessionState, options: ChatExportOptions = {}): string {
  const includeTools = options.includeTools !== false;
  const out: string[] = [];
  out.push(`# ${chatExportTitle(state, options).replace(/\r?\n/g, " ")}`, "");
  const meta = [`Exported from Atomic Agent on ${stamp(options.now ?? Date.now())}`];
  const started = stamp(state.createdAt);
  if (started) meta.push(`chat started ${started}`);
  out.push(`_${meta.join(", ")}._`, "");

  let speaker: "user" | "agent" | null = null;
  let toolLines: string[] = [];
  const agentHeading = (): void => {
    if (speaker !== "agent") {
      out.push("## Atomic Agent", "");
      speaker = "agent";
    }
  };
  const flushTools = (): void => {
    if (toolLines.length === 0) return;
    agentHeading();
    out.push(...toolLines, "");
    toolLines = [];
  };

  state.turns.forEach((turn, index) => {
    switch (turn.kind) {
      case "user": {
        flushTools();
        out.push(turn.steered ? "## You (sent while it was working)" : "## You", "");
        out.push(turn.text.trimEnd() || "_(empty message)_", "");
        speaker = "user";
        return;
      }
      case "assistant_tool_call": {
        if (!includeTools) return;
        const failed = callFailed(state.turns, index, turn);
        const words = options.describeToolCall
          ? options.describeToolCall({ tool: turn.tool, args: turn.args, ok: !failed })
          : `Used ${turn.tool}`;
        toolLines.push(`- ${words.replace(/\r?\n/g, " ")}${failed ? " (failed)" : ""}`);
        return;
      }
      case "tool_result":
        return;
      case "assistant_reply": {
        flushTools();
        agentHeading();
        if (turn.stopped) {
          out.push("_Stopped._", "");
          return;
        }
        out.push(turn.text.trimEnd() || "_(empty reply)_", "");
        if (turn.attachments && turn.attachments.length > 0) {
          out.push("Files:", "", ...turn.attachments.map((p) => `- \`${p}\``), "");
        }
        return;
      }
    }
  });
  flushTools();
  return `${maskChatExportText(out.join("\n"), options).trimEnd()}\n`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Only links that open a page or a mail; a `javascript:` link becomes its text. */
function safeHref(href: string): string | null {
  const h = href.trim();
  return /^(https?:|mailto:|#)/i.test(h) ? h : null;
}

/**
 * HTML a browser or Electron's `printToPDF` can lay out. Raw HTML in a
 * message is shown as text, never run, and the page may load nothing
 * from the network (CSP), so opening an export cannot fetch or execute
 * anything a message carried.
 */
export function renderChatHtml(markdown: string, title: string, options: ChatExportOptions = {}): string {
  markdown = maskChatExportText(markdown, options);
  title = maskChatExportText(title, options);
  const md = new Marked({
    gfm: true,
    renderer: {
      html(token: Tokens.HTML | Tokens.Tag): string {
        return escapeHtml(token.text);
      },
      link(token: Tokens.Link): string {
        const text = this.parser.parseInline(token.tokens);
        const href = safeHref(token.href);
        return href ? `<a href="${escapeHtml(href)}">${text}</a>` : text;
      },
      image(token: Tokens.Image): string {
        return escapeHtml(token.text || token.href);
      },
    },
  });
  const body = md.parse(markdown, { async: false });
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`,
    `<title>${escapeHtml(title)}</title>`,
    "<style>",
    "body{font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1d1d1f;max-width:760px;margin:32px auto;padding:0 24px}",
    "h1{font-size:24px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 6px;color:#555;text-transform:uppercase;letter-spacing:.04em}",
    "pre{background:#f5f5f7;padding:12px;border-radius:6px;overflow-x:auto;white-space:pre-wrap;word-break:break-word}",
    "code{font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}",
    "table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px}blockquote{margin:0;padding-left:12px;border-left:3px solid #ccc;color:#555}",
    "</style>",
    "</head>",
    "<body>",
    body,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
