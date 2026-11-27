import type { DocumentFormat, Extractor, ExtractResult } from "./extractor-types.js";
import { FragmentBudget, FragmentOutput } from "./fragment-budget.js";
import { boundedHtmlToMarkdown } from "./html-markdown.js";
import { decodeBytes } from "./text-decode.js";

/**
 * Email extractors: a single RFC 5322 / MIME message (`.eml`) and a Unix
 * mailbox of many messages (`.mbox`). Plain MIME text, so this is a small
 * self-contained parser rather than a dependency:
 *
 * - headers are unfolded and RFC 2047 encoded words (`=?utf-8?B?…?=`) are
 *   decoded, so subjects and names in any script come out readable;
 * - bodies honour `Content-Transfer-Encoding` (base64, quoted-printable,
 *   7bit/8bit) and the part's `charset`;
 * - `multipart/alternative` shows one body, preferring text/plain and
 *   falling back to the HTML part rendered as markdown;
 * - `multipart/mixed` / `related` show every text part in order;
 * - attachments are listed by name, type and size, never inlined;
 * - attached messages (`message/rfc822`, i.e. forwards) are rendered
 *   recursively.
 *
 * Outlook `.msg` is a different, binary (OLE2) container: see
 * `msg-extractor.ts`, which renders it in the same shape.
 */
const SHOWN_HEADERS = ["from", "to", "cc", "date", "subject"] as const;
const MAX_DEPTH = 8;

interface TextPartRange {
  start: number;
  end: number;
  seen: number;
  resumeAt?: number;
  partial?: number;
}

export const emlExtractor: Extractor = async (input) => {
  const warnings: string[] = [];
  const raw = input.data.toString("latin1");
  const budget = new FragmentBudget(input.maxBytes);
  const output = new FragmentOutput(budget.maxOutputBytes);
  const range: TextPartRange = {
    start: input.pagesFrom ?? 1,
    end: input.pagesTo ?? Infinity,
    seen: 0,
  };
  const text = renderMessage(raw, 0, warnings, budget, output, "", range);
  if (range.partial !== undefined) {
    const continuation = range.partial < range.seen
      ? ` Use pagesFrom=${range.partial + 1} to continue with the next part.`
      : "";
    warnings.push(`MIME part ${range.partial} was truncated.${continuation}`);
  } else if (range.resumeAt !== undefined) {
    warnings.push(output.framingLimited
      ? `No body text was shown because the MIME headers and framing leave no room within maxBytes. Increase maxBytes and use pagesFrom=${range.resumeAt} to retry this part.`
      : `MIME text budget exhausted at part ${range.resumeAt}; further text was skipped. Use pagesFrom=${range.resumeAt} to resume.`);
  }
  if (input.pagesFrom !== undefined && range.start > range.seen) {
    warnings.push(`MIME pagesFrom=${range.start} exceeds the ${range.seen} available body parts.`);
  }
  return {
    format: "eml",
    text: text.trim(),
    warnings: dedupe(warnings),
    ...((budget.exhausted || output.truncated) && { truncated: true }),
  };
};

export const mboxExtractor: Extractor = async (input) => {
  const warnings: string[] = [];
  const messages = splitMbox(input.data.toString("latin1"));
  const total = messages.length;
  const budget = new FragmentBudget(input.maxBytes);
  const output = new FragmentOutput(budget.maxOutputBytes);
  const result = (text: string, extracted: number[]): ExtractResult => ({
    format: "mbox" satisfies DocumentFormat,
    text,
    pageCount: total,
    pagesExtracted: extracted,
    warnings: dedupe(warnings),
    ...((budget.exhausted || output.truncated) && { truncated: true }),
  });
  if (total === 0) {
    warnings.push("no messages found (expected lines starting with \"From \")");
    return result("", []);
  }

  const start = Math.max(1, input.pagesFrom ?? 1);
  const end = Math.min(total, input.pagesTo ?? total);
  const maxPages = input.maxPages ?? total;
  const separators = input.pageSeparators !== false;
  const chunks: string[] = [];
  const extracted: number[] = [];
  for (let n = start; n <= end; n++) {
    if (extracted.length >= maxPages) break;
    const message = new FragmentOutput(output.limit);
    const text = renderMessage(messages[n - 1]!, 0, warnings, budget, message, "").trim();
    if (message.framingLimited) {
      output.stop();
      warnings.push(`No message text was shown because the MBOX headers leave no room within maxBytes. Increase maxBytes and use pagesFrom=${n} to retry this message.`);
      break;
    }
    if (budget.exhausted && !message.partialItem) {
      output.stop();
      warnings.push(`MBOX text budget exhausted at message ${n}. Use pagesFrom=${n} to resume.`);
      break;
    }
    const item = separators ? `--- message ${n} ---\n${text}` : text;
    const shown = output.appendItem(chunks.length && item ? "\n\n" : "", item, message.truncated);
    if (shown.text) chunks.push(shown.text);
    if (shown.status === "partial") {
      const continuation = n < total ? ` Use pagesFrom=${n + 1} to continue with the next message.` : "";
      warnings.push(`MBOX message ${n} was truncated.${continuation}`);
      break;
    }
    if (shown.status === "deferred") {
      warnings.push(`MBOX text budget exhausted at message ${n}. Use pagesFrom=${n} to resume.`);
      break;
    }
    extracted.push(n);
  }
  const remaining = end - start + 1 - extracted.length;
  if (remaining > 0 && !budget.exhausted && !output.stopped) {
    warnings.push(
      `stopped at maxPages=${maxPages}; ${remaining} more message(s) not read (use pagesFrom)`,
    );
  }
  return result(chunks.join("").trim(), extracted);
};

/**
 * mboxo/mboxrd: a message starts at a `From ` line at the top of the file
 * or right after a blank line. Body lines that began with `From ` were
 * escaped as `>From ` (mboxrd adds one `>` per level); undo one level.
 */
function splitMbox(raw: string): string[] {
  const lines = raw.split(/\r?\n/);
  const messages: string[] = [];
  let current: string[] | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("From ") && (i === 0 || lines[i - 1] === "")) {
      if (current) messages.push(current.join("\n"));
      current = [];
      continue;
    }
    if (current) current.push(line.replace(/^>(>*From )/, "$1"));
  }
  if (current) messages.push(current.join("\n"));
  return messages.filter((m) => m.trim().length > 0);
}

// ---------------------------------------------------------------- parsing

interface Part {
  headers: Map<string, string>;
  /** Body as a latin1 "binary" string: one char per byte, still encoded. */
  body: string;
}

function splitPart(raw: string): Part {
  const firstLine = /^[^\r\n]*/.exec(raw)?.[0] ?? "";
  // A file that does not open with a header line is treated as a bare
  // text body (some tools save just the message text with a .eml name).
  if (!/^[!-9;-~]+:/.test(firstLine)) {
    return { headers: new Map(), body: raw };
  }
  const gap = /\r?\n\r?\n/.exec(raw);
  const headerText = gap ? raw.slice(0, gap.index) : raw;
  const body = gap ? raw.slice(gap.index + gap[0].length) : "";
  const headers = new Map<string, string>();
  for (const line of headerText.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    // First occurrence wins: that is the one a mail client shows.
    if (!headers.has(name)) headers.set(name, line.slice(colon + 1).trim());
  }
  return { headers, body };
}

interface HeaderValue {
  value: string;
  params: Record<string, string>;
}

function parseStructuredHeader(raw: string | undefined): HeaderValue {
  if (!raw) return { value: "", params: {} };
  const semi = raw.indexOf(";");
  const value = (semi === -1 ? raw : raw.slice(0, semi)).trim().toLowerCase();
  const params: Record<string, string> = {};
  const continued: Record<string, string[]> = {};
  const re = /;\s*([^=\s;]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^;]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const key = m[1]!.toLowerCase();
    let val = m[2]!.trim();
    if (val.startsWith('"')) val = val.slice(1, -1).replace(/\\(.)/g, "$1");
    // RFC 2231: `filename*=utf-8''na%C3%AFve.pdf` and the split form
    // `filename*0*=…; filename*1*=…`.
    const split = /^(.+?)\*(\d+)\*?$/.exec(key);
    if (split) {
      (continued[split[1]!] ??= [])[Number(split[2])] = val;
      continue;
    }
    if (key.endsWith("*")) {
      params[key.slice(0, -1)] = decodeRfc2231(val);
      continue;
    }
    params[key] = val;
  }
  for (const [key, pieces] of Object.entries(continued)) {
    if (params[key]) continue;
    params[key] = decodeRfc2231(pieces.join(""));
  }
  return { value, params };
}

function decodeRfc2231(value: string): string {
  const m = /^([^']*)'[^']*'(.*)$/.exec(value);
  if (!m) return value;
  const bytes = percentBytes(m[2]!);
  return decodeBytes(bytes, m[1] || "utf-8").text;
}

function percentBytes(value: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "%" && /^[0-9a-fA-F]{2}$/.test(value.slice(i + 1, i + 3))) {
      out.push(parseInt(value.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out.push(value.charCodeAt(i) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** RFC 2047 encoded words in header values. */
export function decodeHeaderWords(value: string): string {
  // Whitespace between two adjacent encoded words is not displayed.
  const joined = value.replace(/(\?=)\s+(?==\?)/g, "$1");
  const decoded = joined.replace(
    /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g,
    (_all, charset: string, enc: string, text: string) => {
      const bytes =
        enc.toUpperCase() === "B"
          ? Buffer.from(text, "base64")
          : qpBytes(text.replace(/_/g, " "));
      return decodeBytes(bytes, charset.split("*")[0]).text;
    },
  );
  // Raw 8-bit headers (no encoded words) are usually UTF-8 these days.
  return decoded === joined &&
    /[\x80-\xff]/.test(decoded) &&
    !/[^\x00-\xff]/.test(decoded)
    ? decodeBytes(Buffer.from(decoded, "latin1")).text
    : decoded;
}

function qpBytes(value: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === "=" && /^[0-9a-fA-F]{2}$/.test(value.slice(i + 1, i + 3))) {
      out.push(parseInt(value.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out.push(ch.charCodeAt(0) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

function decodeTransfer(body: string, encoding: string | undefined): Uint8Array {
  const enc = (encoding ?? "").trim().toLowerCase();
  if (enc === "base64") return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
  if (enc === "quoted-printable") return qpBytes(body.replace(/=\r?\n/g, ""));
  return Buffer.from(body, "latin1");
}

function attachmentSize(body: string, encoding: string | undefined): number {
  const enc = (encoding ?? "").trim().toLowerCase();
  if (enc === "base64") {
    let digits = 0;
    for (const [run] of body.matchAll(/[A-Za-z0-9+/]+|=/g)) {
      if (run === "=") break;
      digits += run.length;
    }
    return Math.floor(digits * 3 / 4);
  }
  if (enc === "quoted-printable") {
    const joined = body.replace(/=\r?\n/g, "");
    let size = joined.length;
    for (const _ of joined.matchAll(/=[\da-f]{2}/gi)) size -= 2;
    return size;
  }
  return body.length;
}

// -------------------------------------------------------------- rendering

function renderMessage(
  raw: string,
  depth: number,
  warnings: string[],
  budget: FragmentBudget,
  output: FragmentOutput,
  prefix: string,
  range?: TextPartRange,
): string {
  const part = splitPart(raw);
  const lines: string[] = [];
  for (const name of SHOWN_HEADERS) {
    const value = part.headers.get(name);
    if (value) lines.push(`${capitalise(name)}: ${decodeHeaderWords(value)}`);
  }
  const attachments: string[] = [];
  const head = lines.join("\n");
  const bodyPrefix = head ? prefix + head + "\n\n" : prefix;
  const precedingParts = range?.seen ?? 0;
  const body = renderPart(part, depth, warnings, attachments, budget, output, bodyPrefix, range);
  if (range && depth > 0) {
    // A forwarded message that contains only attachments belongs to the
    // next body position, even though it does not advance the part count.
    const lastPart = range.seen + (attachments.length > 0 && range.seen === precedingParts ? 1 : 0);
    if ((range.start > 1 && lastPart < range.start) || precedingParts >= range.end) return body;
  }
  if (output.stopped) return body;
  if (attachments.length > 0) {
    const attachmentPrefix = body ? "\n\n" : bodyPrefix;
    return body + output.append(attachmentPrefix + `Attachments:\n${attachments.map((a) => `- ${a}`).join("\n")}`);
  }
  return body || (head ? output.append(prefix + head) : "");
}

function renderTextPart(
  bodySize: number,
  budget: FragmentBudget,
  output: FragmentOutput,
  prefix: string,
  range: TextPartRange | undefined,
  render: (inputBytes: number) => { text: string; truncated?: boolean },
): string {
  const part = range ? ++range.seen : 0;
  if (range && (part < range.start || part > range.end)) return "";
  if (output.stopped) return "";
  const accepted = budget.take(bodySize);
  if (accepted === undefined) {
    output.stop();
    if (range) range.resumeAt = part;
    return "";
  }
  const rendered = render(accepted);
  const text = rendered.text.trim();
  const clipped = rendered.truncated || accepted < bodySize;
  if (accepted < bodySize) budget.noteTruncation();
  if (!text && !clipped) return "";
  const shown = output.appendItem(prefix, text, clipped);
  if (range && shown.status === "partial") range.partial = part;
  if (range && shown.status === "deferred") range.resumeAt = part;
  return shown.text;
}

function readPartText(part: Part, inputBytes: number, warnings: string[]): string {
  const encoding = part.headers.get("content-transfer-encoding");
  const type = parseStructuredHeader(part.headers.get("content-type"));
  const decoded = decodeBytes(decodeTransfer(part.body.slice(0, inputBytes), encoding), type.params.charset);
  if (decoded.warning) warnings.push(decoded.warning);
  return decoded.text.replace(/\r\n?/g, "\n");
}

function renderPart(
  part: Part,
  depth: number,
  warnings: string[],
  attachments: string[],
  budget: FragmentBudget,
  output: FragmentOutput,
  prefix: string,
  range?: TextPartRange,
  htmlAlternative?: Part,
): string {
  const type = parseStructuredHeader(part.headers.get("content-type") ?? "text/plain");
  const mime = type.value || "text/plain";
  if (depth > MAX_DEPTH) {
    warnings.push(`MIME nesting deeper than ${MAX_DEPTH} levels was cut`);
    return "";
  }
  const disposition = parseStructuredHeader(part.headers.get("content-disposition"));
  const attached = disposition.value === "attachment";
  const encoding = part.headers.get("content-transfer-encoding");

  if (mime.startsWith("multipart/") && !attached) {
    const boundary = type.params.boundary;
    if (!boundary) {
      return renderTextPart(part.body.length, budget, output, prefix, range, (inputBytes) => {
        warnings.push(`${mime} without a boundary; shown as text`);
        return decodeBytes(Buffer.from(part.body.slice(0, inputBytes), "latin1"));
      });
    }
    const rawChildren = splitMultipart(part.body, boundary);
    if (mime === "multipart/alternative") {
      let plain: Part | undefined;
      let html: Part | undefined;
      let last: Part | undefined;
      for (const child of rawChildren) {
        const candidate = splitPart(child);
        if (isAttachment(candidate)) {
          renderPart(candidate, depth + 1, warnings, attachments, budget, output, prefix, range);
          continue;
        }
        last = candidate;
        const childMime = partMime(last);
        if (childMime === "text/plain") plain ??= last;
        if (childMime === "text/html") html ??= last;
      }
      const pick = plain && (!html || budget.canTake(plain.body.length)) ? plain : html ?? last;
      return pick ? renderPart(pick, depth + 1, warnings, attachments, budget, output, prefix, range, pick === plain ? html : undefined) : "";
    }
    const chunks: string[] = [];
    for (const child of rawChildren) {
      const text = renderPart(splitPart(child), depth + 1, warnings, attachments, budget, output, chunks.length ? "\n\n" : prefix, range);
      if (text) chunks.push(text);
    }
    return chunks.join("");
  }

  if (mime === "message/rfc822" && !attached) {
    const bytes = decodeTransfer(part.body, encoding);
    return renderMessage(Buffer.from(bytes).toString("latin1"), depth + 1, warnings, budget, output,
      prefix + "--- attached message ---\n", range);
  }

  const isText = mime === "text/plain" || mime === "text/html";
  if (!isText || attached) {
    const label = decodeHeaderWords(disposition.params.filename ?? type.params.name ?? "") || "(unnamed)";
    attachments.push(`${label} (${mime}, ${formatSize(attachmentSize(part.body, encoding))})`);
    return "";
  }

  return renderTextPart(part.body.length, budget, output, prefix, range, (inputBytes) => {
    const text = readPartText(part, inputBytes, warnings);
    if (mime === "text/html") return boundedHtmlToMarkdown(text, warnings, undefined, budget);
    if (!text.trim() && htmlAlternative) {
      // Both representations belong to the same displayed MIME part.
      const alternateSize = budget.take(htmlAlternative.body.length);
      if (alternateSize === undefined) return { text: "", truncated: true };
      const html = boundedHtmlToMarkdown(readPartText(htmlAlternative, alternateSize, warnings), warnings, undefined, budget);
      if (alternateSize < htmlAlternative.body.length) {
        budget.noteTruncation();
        html.truncated = true;
      }
      return html;
    }
    return { text };
  });
}

function partMime(part: Part): string {
  return parseStructuredHeader(part.headers.get("content-type") ?? "text/plain").value || "text/plain";
}

function isAttachment(part: Part): boolean {
  return parseStructuredHeader(part.headers.get("content-disposition")).value === "attachment";
}

function* splitMultipart(body: string, boundary: string): Generator<string> {
  const delimiter = `--${boundary}`;
  const closing = delimiter + "--";
  let current: string[] | null = null;
  for (let start = 0; start <= body.length; ) {
    const newline = body.indexOf("\n", start);
    const end = newline === -1 ? body.length : newline;
    const line = body.slice(start, newline !== -1 && body[end - 1] === "\r" ? end - 1 : end);
    start = newline === -1 ? body.length + 1 : newline + 1;
    if (line.startsWith(delimiter)) {
      const trimmed = line.trimEnd();
      if (trimmed === delimiter || trimmed === closing) {
        if (current) yield current.join("\n");
        if (trimmed === closing) return;
        current = [];
        continue;
      }
    }
    // Lines before the first delimiter are the MIME preamble: ignored.
    current?.push(line);
  }
  // Truncated message without a closing delimiter: keep the last part.
  if (current) yield current.join("\n");
}

function capitalise(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}
