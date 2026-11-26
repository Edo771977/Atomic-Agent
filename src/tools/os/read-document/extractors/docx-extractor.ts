import type { ExtractorInput, ExtractResult } from "./extractor-types.js";
import { loadBoundedOfficeZip } from "../../ooxml/bounded-office-zip.js";

type DocxOptions = {
  includeEmbeddedStyleMap?: boolean;
  externalFileAccess?: boolean;
};

/**
 * DOCX text extractor backed by `mammoth`.
 *
 * Mammoth converts DOCX to HTML or markdown with configurable style maps.
 * For our purpose — producing token-frugal plain text for local LLMs — we
 * use `convertToMarkdown` and then strip the few markers that don't help
 * a model (HTML comments, reference-style links). We keep headings (`#`),
 * lists (`-`), and tables (`|`), which give the model cheap structural
 * hints.
 */
export async function docxExtractor(input: ExtractorInput, options?: DocxOptions): Promise<ExtractResult> {
  const zip = await loadBoundedOfficeZip(input.data);
  const mammoth = await loadMammoth();
  const warnings: string[] = [];

  const convertFn =
    input.includeTables === false
      ? mammoth.extractRawText
      : mammoth.convertToMarkdown;

  // Mammoth's ZIP adapter accepts a file object. Reuse the checked entries
  // directly, including cached XML, without copying stored media into a new ZIP.
  const file: MammothArchive = {
    exists: (name) => zip.file(name) !== null,
    async read(name, encoding) {
      const entry = zip.file(name);
      if (!entry) throw new Error(`DOCX part not found: ${name}`);
      const bytes = await entry.async("nodebuffer");
      if (encoding === "base64") return bytes.toString("base64");
      return encoding ? new TextDecoder(encoding).decode(bytes) : bytes;
    },
  };
  const result = await convertFn({ file }, options);
  for (const msg of result.messages) {
    if (msg.type === "error" || msg.type === "warning") {
      warnings.push(`${msg.type}: ${msg.message}`);
    }
  }
  const text = normaliseMarkdown(result.value);
  return {
    format: "docx",
    text,
    warnings,
  };
}

function normaliseMarkdown(raw: string): string {
  return (
    raw
      // Collapse >2 blank lines to exactly 2 to keep paragraph breaks.
      .replace(/\n{3,}/g, "\n\n")
      // Trim trailing whitespace on each line.
      .split("\n")
      .map((line) => line.replace(/[ \t]+$/g, ""))
      .join("\n")
      .trim()
  );
}

interface MammothArchive {
  exists(name: string): boolean;
  read(name: string, encoding?: string): Promise<Buffer | string>;
}

type MammothFn = (input: { file: MammothArchive }, options?: DocxOptions) => Promise<{
  value: string;
  messages: Array<{ type: string; message: string }>;
}>;

interface MammothModule {
  convertToMarkdown: MammothFn;
  extractRawText: MammothFn;
}

let mammothModule: MammothModule | undefined;
async function loadMammoth(): Promise<MammothModule> {
  if (!mammothModule) {
    // mammoth ships CommonJS; its ESM interop view exposes both the named
    // exports and a `.default` alias. We normalise to the shape we use via
    // `unknown` because its published types omit `convertToMarkdown`
    // despite the function existing in the JS source.
    const mod = (await import("mammoth")) as unknown as
      MammothModule | { default: MammothModule };
    mammothModule = "default" in mod ? mod.default : mod;
  }
  return mammothModule;
}
