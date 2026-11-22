import { Lexer, type MarkedToken, type Token, type Tokens } from "marked";

import { docxExtractor } from "../os/read-document/extractors/docx-extractor.js";
import { pdfExtractor } from "../os/read-document/extractors/pdf-extractor.js";

export const DOCUMENT_LANGUAGES = ["en", "it", "es", "fr", "de", "pt"] as const;
type Language = (typeof DOCUMENT_LANGUAGES)[number];

export interface DocumentSpec {
  readonly requiredSections?: readonly string[];
  readonly wordRange?: { readonly min: number; readonly max: number };
  readonly language?: Language;
  readonly extraPlaceholders?: readonly string[];
}

type DocumentResult = { status: "pass" | "fail" | "uncheckable"; detail: string };
const MAX_LIST_LENGTH = 32;
const MAX_LABEL_LENGTH = 120;
const MAX_EXTRACTED_CHARS = 2_000_000;
const MAX_PDF_PAGES = 200;
const PLACEHOLDERS = ["TODO", "TBD", "lorem ipsum", "[inserire]", "[insert]", "XXX"];

function invalid(field: string, condition: string): never {
  throw new Error(`verify.run: \`${field}\` ${condition}`);
}

function labelList(input: unknown, field: string): string[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length > MAX_LIST_LENGTH) {
    invalid(field, `must be an array of at most ${MAX_LIST_LENGTH} strings`);
  }
  return input.map((value: unknown) => {
    if (typeof value !== "string" || !value.trim() || value.length > MAX_LABEL_LENGTH || /[\p{Cc}]/u.test(value)) {
      invalid(field, `must contain nonblank strings of at most ${MAX_LABEL_LENGTH} characters without control characters`);
    }
    return value.trim();
  });
}

function parseWordRange(input: unknown): DocumentSpec["wordRange"] {
  if (input === undefined) return undefined;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    invalid("wordRange", "must be an object with min and max");
  }
  const { min, max } = input as Record<string, unknown>;
  if (Object.keys(input).some((field) => field !== "min" && field !== "max")
    || typeof min !== "number" || typeof max !== "number"
    || !Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 0 || max < min) {
    invalid("wordRange", "must have nonnegative integer min and max, with min <= max");
  }
  return { min, max };
}

export function parseDocumentSpec(raw: Record<string, unknown>): DocumentSpec {
  const { language } = raw;
  if (language !== undefined && !DOCUMENT_LANGUAGES.some((candidate) => candidate === language)) {
    invalid("language", `must be one of ${DOCUMENT_LANGUAGES.join(", ")}`);
  }
  const requiredSections = labelList(raw.requiredSections, "requiredSections");
  const wordRange = parseWordRange(raw.wordRange);
  const extraPlaceholders = labelList(raw.extraPlaceholders, "extraPlaceholders");
  return {
    ...(requiredSections === undefined ? {} : { requiredSections }),
    ...(wordRange === undefined ? {} : { wordRange }),
    ...(language === undefined ? {} : { language: language as Language }),
    ...(extraPlaceholders === undefined ? {} : { extraPlaceholders }),
  };
}

function normalized(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

function markdownText(tokens: readonly Token[], separator: string): string {
  return tokens.map((rawToken) => {
    const token = rawToken as MarkedToken;
    switch (token.type) {
      case "br":
      case "space":
        return "\n";
      case "html":
        return token.text.replace(/<!--[\s\S]*?-->/gu, "").replace(/<[^>]+>/gu, " ");
      case "table":
        return [token.header, ...token.rows].map(
          (row) => row.map((cell) => markdownText(cell.tokens, "")).join(" "),
        ).join("\n");
      case "list":
        return markdownText(token.items, "\n");
      case "list_item":
      case "blockquote":
        return markdownText(token.tokens, "\n");
      case "paragraph":
      case "heading":
      case "strong":
      case "em":
      case "del":
      case "link":
      case "image":
        return markdownText(token.tokens, "");
      case "text":
        return token.tokens === undefined ? token.text : markdownText(token.tokens, "");
      case "escape":
      case "code":
      case "codespan":
        return token.text;
      default:
        return "";
    }
  }).join(separator);
}

interface DocumentText { text: string; headings: string[] }
type Extraction = DocumentText | DocumentResult;

function uncheckable(detail: string): DocumentResult {
  return { status: "uncheckable", detail };
}

async function extractDocument(bytes: Buffer, extension: string): Promise<Extraction> {
  const input = { data: bytes, sourcePath: extension };
  let text: string;
  if (extension === ".docx") {
    const doc = await docxExtractor(input, { includeEmbeddedStyleMap: false, externalFileAccess: false });
    if (doc.warnings.some((warning) => warning.startsWith("error:"))) {
      return uncheckable("DOCX text extraction reported an error");
    }
    text = doc.text;
  } else if (extension === ".pdf") {
    const pdf = await pdfExtractor({ ...input, maxPages: MAX_PDF_PAGES, pageSeparators: false, includeTables: false });
    if ((pdf.pageCount ?? 0) > MAX_PDF_PAGES) {
      return uncheckable(`PDF exceeds the ${MAX_PDF_PAGES}-page extraction limit`);
    }
    if (!pdf.pageCount || pdf.pagesExtracted?.length !== pdf.pageCount || pdf.textLayer?.ocrNeeded) {
      return uncheckable("PDF has pages with unavailable text");
    }
    text = pdf.text;
  } else if (extension === ".txt" || extension === ".md") {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) return uncheckable("document contains binary data");
  } else {
    return uncheckable("unsupported document format");
  }
  if (text.length > MAX_EXTRACTED_CHARS) {
    return uncheckable(`document exceeds the ${MAX_EXTRACTED_CHARS}-character text limit`);
  }
  if (extension === ".md" || extension === ".docx") {
    const tokens = Lexer.lex(text, { gfm: true });
    const headings = tokens
      .filter((token): token is Tokens.Heading => token.type === "heading")
      .map((heading) => markdownText(heading.tokens, ""));
    return { text: markdownText(tokens, "\n"), headings };
  }
  return { text, headings: text.split(/\r\n?|\n/u) };
}

const LANGUAGE_MARKERS: Readonly<Record<Language, string>> = {
  en: "the and of to from with within for by at on into that this these those have will was were is are we they you their our should could would before after most each next which where when",
  it: "il lo gli le un una che degli delle della dallo con per tra fra sul sulla sono essere stato hanno abbiamo durante alle dagli anche quindi come nostri loro alla nel nello prima dopo",
  es: "el los las una unos unas del para por como que sus han hemos durante porque sobre desde hasta entre este esta estas son hay fueron está cada quien nuestro nuestros después antes",
  fr: "le les des du une dans avec pour sur sous qui que ses leur leurs ont nous vous aux par est être sont été cette ces mais donc chaque avant après pendant notre votre",
  de: "der die das den dem des ein eine einer einen eines einem und ist sind war waren wird werden von für mit auf aus bei nach vor zum zur sich nicht wir sie unser unsere",
  pt: "os as dos das do da uma umas uns pelo pela pelos pelas para por com sem nos nas aos são têm estão essas esses que seus suas entre sobre nosso nossa depois antes",
};
const MIN_LANGUAGE_WORDS = 20;
const MIN_LANGUAGE_MARKERS = 5;
const MIN_LANGUAGE_LEAD = 3;
const MIN_LANGUAGE_MARKER_SHARE = 0.1;

function detectLanguage(words: readonly string[]): Language | undefined {
  if (words.length < MIN_LANGUAGE_WORDS) return undefined;
  const counts = new Map<string, number>();
  for (const word of words) {
    const key = word.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const scores = DOCUMENT_LANGUAGES.map((language) => ({
    language,
    hits: LANGUAGE_MARKERS[language].split(" ").map((word) => counts.get(word) ?? 0).filter((count) => count > 0),
  })).sort((a, b) => b.hits.length - a.hits.length);
  const [first, second] = scores;
  if (first === undefined || second === undefined) return undefined;
  if (
    first.hits.length < MIN_LANGUAGE_MARKERS
    || first.hits.length - second.hits.length < MIN_LANGUAGE_LEAD
    || first.hits.reduce((sum, hits) => sum + hits, 0) < words.length * MIN_LANGUAGE_MARKER_SHARE
  ) return undefined;
  return first.language;
}

function hasPlaceholder(text: string, marker: string): boolean {
  const pattern = normalized(marker).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  // Bracketed markers already delimit themselves, even when adjacent to a word.
  const start = /^[\p{L}\p{M}\p{N}_]/u.test(pattern) ? "(?<![\\p{L}\\p{M}\\p{N}_])" : "";
  const end = /[\p{L}\p{M}\p{N}_]$/u.test(pattern) ? "(?![\\p{L}\\p{M}\\p{N}_])" : "";
  return new RegExp(start + pattern + end, "u").test(text);
}

export async function evaluateDocument(bytes: Buffer, extension: string, spec: DocumentSpec): Promise<DocumentResult> {
  let extracted: Extraction;
  try {
    extracted = await extractDocument(bytes, extension.toLowerCase());
  } catch {
    return uncheckable(`could not extract text from ${extension}`);
  }
  if ("status" in extracted) return extracted;
  const headings = new Set(extracted.headings.map(normalized));
  const missing = (spec.requiredSections ?? []).filter((title) => !headings.has(normalized(title)));
  const words = extracted.text.normalize("NFKC").match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:[’'-][\p{L}\p{N}][\p{L}\p{M}\p{N}]*)*/gu) ?? [];
  const text = normalized(extracted.text);
  const placeholders = [...PLACEHOLDERS, ...(spec.extraPlaceholders ?? [])].filter((marker) => hasPlaceholder(text, marker));

  const failures = missing.length === 0 ? [] : [`missing section(s) ${missing.join(", ")}`];
  if (spec.wordRange && (words.length < spec.wordRange.min || words.length > spec.wordRange.max)) {
    failures.push(`${words.length} words, expected ${spec.wordRange.min}–${spec.wordRange.max}`);
  }
  if (placeholders.length > 0) failures.push(`placeholder(s) ${placeholders.join(", ")}`);

  const detected = spec.language === undefined ? undefined : detectLanguage(words);
  if (spec.language !== undefined && detected !== undefined && detected !== spec.language) {
    failures.push(`expected language ${spec.language}, detected ${detected}`);
  }
  if (spec.language !== undefined && detected === undefined) {
    return uncheckable([`could not determine document language (expected ${spec.language})`, ...failures].join(". "));
  }
  if (failures.length > 0) return { status: "fail", detail: failures.join(". ") };
  return {
    status: "pass",
    detail: `document verified (${words.length} words${detected === undefined ? "" : `, language ${detected}`})`,
  };
}
