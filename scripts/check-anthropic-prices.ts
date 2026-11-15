/**
 * Check the committed Anthropic official price table against the
 * official pricing page.
 *
 *   npm run prices:anthropic                     # fetch, compare, print a diff
 *   npm run prices:anthropic -- --write          # also rewrite the table and its date
 *   npm run prices:anthropic -- --source page.md # read a saved copy instead
 *
 * Fetches https://platform.claude.com/docs/en/about-claude/pricing.md
 * (the docs site serves Markdown), falling back to the HTML page, and
 * parses two tables: "Model pricing" (base input, 5-minute cache write,
 * cache hit, output; the Haiku 5.5 "for prompts over N tokens" row
 * becomes `longContext`) and "Fast mode pricing" (stored as a multiplier
 * of the base rate). Retired rows are skipped, as the table leaves them
 * out. A model name the mapping does not know is reported, never
 * guessed, and blocks `--write`.
 *
 * Exit codes: 0 the table matches (or `--write` rewrote it), 1 the
 * table differs, 2 the page could not be read or parsed, or a row could
 * not be mapped. Respects offline mode (`ATOMIC_AGENT_OFFLINE`,
 * `network.offline`). The only network access is that one page.
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { applyOfflineModeFromConfigFile } from "../src/cli/offline-from-config.js";
import { isOfflineNetwork } from "../src/llm/offline-network.js";
import {
  ANTHROPIC_FAST_MODE_MULTIPLIERS,
  ANTHROPIC_OFFICIAL_PRICE_ROWS,
  ANTHROPIC_OFFICIAL_PRICES_DATE,
  ANTHROPIC_OFFICIAL_PRICES_PAGE,
} from "../src/llm/provider/official-prices/anthropic-official-prices.js";

export const PRICING_PAGE_URL = ANTHROPIC_OFFICIAL_PRICES_PAGE;

/** `--write` could not save the table: not 1, which means "the table differs". */
export const PRICES_EXIT_WRITE_FAILED = 4;
const TABLE_PATH = fileURLToPath(
  new URL("../src/llm/provider/official-prices/anthropic-official-prices.ts", import.meta.url),
);
export const BLOCK_BEGIN = "// BEGIN GENERATED: npm run prices:anthropic -- --write (do not edit by hand)";
export const BLOCK_END = "// END GENERATED";

export type Rates = { input: number; cacheWrite: number; cacheRead: number; output: number };
export type PriceRow = Rates & { longContext?: Rates & { thresholdTokens: number } };
export type PriceTable = Readonly<Record<string, PriceRow>>;
export type FastTable = Readonly<Record<string, number>>;
/** The committed table's row shape (`UserModelConfigEntry["pricing"]`): cache rates may be absent. */
type LooseRates = { input: number; output: number; cacheRead?: number | undefined; cacheWrite?: number | undefined };
export type CommittedTable = Readonly<Record<string, LooseRates & { longContext?: (LooseRates & { thresholdTokens: number }) | undefined }>>;

export type ParsedPage = {
  prices: Record<string, PriceRow>;
  fast: Record<string, number>;
  /** Fast-mode list prices as printed, for the rendered comments. */
  fastPrices: Record<string, { input: number; output: number }>;
  retired: string[];
  unknown: string[];
  problems: string[];
};

// ---------------------------------------------------------------- cells

/** A cell's plain text: footnote markers, links, emphasis and HTML tags removed. */
export function cleanCell(cell: string): string {
  return cell
    .replace(/<sup>.*?<\/sup>/gi, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/\*\*|__/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** `$0.20 / MTok`, `$16 USD / MTok`, `$1,250 / MTok` → USD per million tokens. */
export function parsePrice(cell: string): number | undefined {
  const m = /^\$\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*(?:USD\s*)?\/\s*MTok$/i.exec(cleanCell(cell));
  if (m === null) return undefined;
  const value = Number(`${m[1]!.replace(/,/g, "")}${m[2] ?? ""}`);
  return Number.isFinite(value) ? value : undefined;
}

export type ModelName =
  | { kind: "model"; id: string; tier: "base" }
  | { kind: "model"; id: string; tier: "long"; thresholdTokens: number }
  | { kind: "retired"; name: string }
  | { kind: "unknown"; name: string };

const FAMILIES = new Set(["fable", "mythos", "opus", "sonnet", "haiku"]);

/**
 * `Claude Fable 5.2` → `claude-fable-5-2`. Parentheticals the page uses
 * are understood: availability notes are ignored, "retired" marks the
 * row retired, "for prompts up to / over N tokens" picks the price tier.
 * Anything else is unknown.
 */
export function mapModelName(raw: string): ModelName {
  const name = cleanCell(raw);
  let tier: { tier: "base" } | { tier: "long"; thresholdTokens: number } = { tier: "base" };
  let rest = name;
  for (const paren of name.match(/\([^)]*\)/g) ?? []) {
    const inner = paren.slice(1, -1).trim().toLowerCase();
    rest = rest.replace(paren, "");
    if (inner.startsWith("retired")) return { kind: "retired", name };
    if (inner === "limited availability" || inner === "limited access") continue;
    const prompt = /^for prompts (up to|over) (\d{1,3}(?:,\d{3})+|\d+) tokens$/.exec(inner);
    if (prompt === null) return { kind: "unknown", name };
    if (prompt[1] === "over") tier = { tier: "long", thresholdTokens: Number(prompt[2]!.replace(/,/g, "")) };
  }
  const m = /^Claude ([A-Za-z]+) (\d+)(?:\.(\d+))?$/.exec(rest.replace(/\s+/g, " ").trim());
  if (m === null || !FAMILIES.has(m[1]!.toLowerCase())) return { kind: "unknown", name };
  const id = ["claude", m[1]!.toLowerCase(), m[2]!, ...(m[3] === undefined ? [] : [m[3]])].join("-");
  return { kind: "model", id, ...tier };
}

// --------------------------------------------------------------- tables

function splitRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split("|").map((c) => c.trim());
}

/** The first table after the heading whose text is `heading`: header cells and body rows. */
export function findTable(markdown: string, heading: string): { header: string[]; rows: string[][] } | undefined {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{2,4}\s/.test(l) && cleanCell(l.replace(/^#+\s*/, "")).toLowerCase() === heading.toLowerCase());
  if (start < 0) return undefined;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (/^#{1,3}\s/.test(line) && !lines[i]!.startsWith("####")) return undefined;
    if (!line.startsWith("|")) continue;
    const header = splitRow(line).map((c) => cleanCell(c).toLowerCase());
    const rows: string[][] = [];
    for (let j = i + 2; j < lines.length && lines[j]!.trim().startsWith("|"); j++) rows.push(splitRow(lines[j]!));
    return { header, rows };
  }
  return undefined;
}

/** A crude HTML → Markdown pass, enough for headings and tables. */
export function htmlToMarkdown(html: string): string {
  const decode = (s: string) =>
    s
      .replace(/&nbsp;|&#160;/g, " ")
      .replace(/&#x27;|&#39;|&rsquo;/g, "'")
      .replace(/&#36;/g, "$")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&");
  const text = (s: string) => decode(s.replace(/<(?!\/?sup\b)[^>]+>/gi, "")).replace(/\s+/g, " ").trim();
  const out: string[] = [];
  const re = /<h([2-4])[^>]*>([\s\S]*?)<\/h\1>|<table[^>]*>([\s\S]*?)<\/table>/gi;
  for (const m of html.matchAll(re)) {
    if (m[1] !== undefined) {
      out.push("", `${"#".repeat(Number(m[1]))} ${text(m[2]!)}`, "");
      continue;
    }
    const rows = [...m[3]!.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) =>
      [...r[1]!.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => text(c[1]!).replace(/\|/g, "/")),
    );
    rows.forEach((cells, i) => {
      out.push(`| ${cells.join(" | ")} |`);
      if (i === 0) out.push(`|${cells.map(() => " --- ").join("|")}|`);
    });
    out.push("");
  }
  return out.join("\n");
}

const MODEL_COLUMNS = {
  model: "model",
  input: "base input tokens",
  cacheWrite: "5m cache writes",
  cacheRead: "cache hits and refreshes",
  output: "output tokens",
} as const;

export function parsePricingPage(markdown: string): ParsedPage {
  const page: ParsedPage = { prices: {}, fast: {}, fastPrices: {}, retired: [], unknown: [], problems: [] };
  const table = findTable(markdown, "Model pricing");
  if (table === undefined) {
    page.problems.push('no "Model pricing" table found');
    return page;
  }
  const col = Object.fromEntries(
    Object.entries(MODEL_COLUMNS).map(([key, title]) => [key, table.header.indexOf(title)]),
  ) as Record<keyof typeof MODEL_COLUMNS, number>;
  const missing = Object.entries(col).filter(([, i]) => i < 0).map(([k]) => MODEL_COLUMNS[k as keyof typeof MODEL_COLUMNS]);
  if (missing.length > 0) {
    page.problems.push(`"Model pricing" table lacks column(s): ${missing.join(", ")}`);
    return page;
  }
  const long = new Map<string, Rates & { thresholdTokens: number }>();
  for (const cells of table.rows) {
    const name = mapModelName(cells[col.model] ?? "");
    if (name.kind === "retired") {
      page.retired.push(name.name);
      continue;
    }
    if (name.kind === "unknown") {
      page.unknown.push(name.name);
      continue;
    }
    const rates: Partial<Rates> = {};
    for (const key of ["input", "cacheWrite", "cacheRead", "output"] as const) {
      const value = parsePrice(cells[col[key]] ?? "");
      if (value === undefined) page.problems.push(`${name.id}: cannot read ${MODEL_COLUMNS[key]} "${cells[col[key]] ?? ""}"`);
      else rates[key] = value;
    }
    if (Object.keys(rates).length !== 4) continue;
    const full = rates as Rates;
    // Two "for prompts over" rows for one model would need a second tier
    // the table cannot hold; keeping the last one would drop a price.
    if (name.tier === "long" && long.has(name.id)) page.problems.push(`${name.id}: long-prompt row listed twice`);
    else if (name.tier === "long") long.set(name.id, { thresholdTokens: name.thresholdTokens, ...full });
    else if (Object.hasOwn(page.prices, name.id)) page.problems.push(`${name.id}: listed twice`);
    else page.prices[name.id] = { ...full };
  }
  for (const [id, tier] of long) {
    const base = page.prices[id];
    if (base === undefined) page.problems.push(`${id}: a long-prompt row without a base row`);
    else base.longContext = tier;
  }
  if (Object.keys(page.prices).length === 0) page.problems.push('"Model pricing" table has no rows');
  parseFastMode(markdown, page);
  return page;
}

function parseFastMode(markdown: string, page: ParsedPage): void {
  const table = findTable(markdown, "Fast mode pricing");
  if (table === undefined) {
    page.problems.push('no "Fast mode pricing" table found');
    return;
  }
  const [m, i, o] = ["model", "input", "output"].map((t) => table.header.indexOf(t));
  if (m! < 0 || i! < 0 || o! < 0) {
    page.problems.push('"Fast mode pricing" table lacks model/input/output columns');
    return;
  }
  for (const cells of table.rows) {
    const input = parsePrice(cells[i!] ?? "");
    const output = parsePrice(cells[o!] ?? "");
    for (const part of (cells[m!] ?? "").split(" / ")) {
      const name = mapModelName(part);
      if (name.kind !== "model" || name.tier !== "base") {
        page.unknown.push(`fast mode: ${cleanCell(part)}`);
        continue;
      }
      const base = page.prices[name.id];
      if (input === undefined || output === undefined) {
        page.problems.push(`fast mode ${name.id}: cannot read its prices`);
      } else if (base === undefined) {
        page.problems.push(`fast mode ${name.id}: not in the model pricing table`);
      } else {
        const factor = input / base.input;
        if (Math.abs(output / base.output - factor) > 1e-9) {
          page.problems.push(`fast mode ${name.id}: input and output scale differently (${input}/${output} on ${base.input}/${base.output})`);
        } else {
          page.fast[name.id] = round(factor);
          page.fastPrices[name.id] = { input, output };
        }
      }
    }
  }
}

const round = (n: number) => Math.round(n * 1e9) / 1e9;

// ----------------------------------------------------------------- diff

export type TableDiff = { added: string[]; removed: string[]; changed: string[] };

function describeRow(row: CommittedTable[string]): string {
  const rates = (r: LooseRates) => `input ${r.input}, cacheWrite ${r.cacheWrite}, cacheRead ${r.cacheRead}, output ${r.output}`;
  return rates(row) + (row.longContext ? `; over ${row.longContext.thresholdTokens} tokens: ${rates(row.longContext)}` : "");
}

export function diffTables(
  committed: { prices: CommittedTable; fast: FastTable },
  page: { prices: CommittedTable; fast: FastTable },
): TableDiff {
  const diff: TableDiff = { added: [], removed: [], changed: [] };
  for (const [id, row] of Object.entries(page.prices)) {
    const old = committed.prices[id];
    if (old === undefined) {
      diff.added.push(`${id}: ${describeRow(row)}`);
      continue;
    }
    const changes: string[] = [];
    for (const key of ["input", "cacheWrite", "cacheRead", "output"] as const) {
      if (old[key] !== row[key]) changes.push(`${key} ${old[key]} -> ${row[key]}`);
    }
    const a = old.longContext;
    const b = row.longContext;
    if ((a === undefined) !== (b === undefined)) {
      changes.push(b === undefined ? "long-prompt rates removed" : `long-prompt rates added (${describeRow(b)})`);
    } else if (a !== undefined && b !== undefined) {
      for (const key of ["thresholdTokens", "input", "cacheWrite", "cacheRead", "output"] as const) {
        if (a[key] !== b[key]) changes.push(`longContext.${key} ${a[key]} -> ${b[key]}`);
      }
    }
    if (changes.length > 0) diff.changed.push(`${id}: ${changes.join(", ")}`);
  }
  for (const id of Object.keys(committed.prices)) {
    if (!Object.hasOwn(page.prices, id)) diff.removed.push(id);
  }
  for (const [id, factor] of Object.entries(page.fast)) {
    const old = committed.fast[id];
    if (old === undefined) diff.added.push(`fast mode ${id}: ${factor}x`);
    else if (old !== factor) diff.changed.push(`fast mode ${id}: ${old}x -> ${factor}x`);
  }
  for (const id of Object.keys(committed.fast)) {
    if (!Object.hasOwn(page.fast, id)) diff.removed.push(`fast mode ${id}`);
  }
  return diff;
}

export function diffIsEmpty(diff: TableDiff): boolean {
  return diff.added.length + diff.removed.length + diff.changed.length === 0;
}

// --------------------------------------------------------------- render

const num = (n: number) => (Number.isInteger(n) && n >= 10_000 ? String(n).replace(/\B(?=(\d{3})+$)/g, "_") : String(n));
const ratesSource = (r: Rates) => `input: ${num(r.input)}, cacheWrite: ${num(r.cacheWrite)}, cacheRead: ${num(r.cacheRead)}, output: ${num(r.output)}`;

/** The generated region of the table file, markers included. Deterministic for a given page. */
export function renderGeneratedBlock(page: Pick<ParsedPage, "prices" | "fast" | "fastPrices">): string {
  const lines = [BLOCK_BEGIN, "const PRICES: Readonly<Record<string, Pricing>> = {"];
  for (const [id, row] of Object.entries(page.prices)) {
    if (row.longContext === undefined) {
      lines.push(`  ${JSON.stringify(id)}: { ${ratesSource(row)} },`);
      continue;
    }
    const t = row.longContext.thresholdTokens.toLocaleString("en-US");
    lines.push(
      `  // Priced by prompt length: a prompt over ${t} tokens (cache reads and`,
      "  // writes included) pays the higher rates for the whole request.",
      `  ${JSON.stringify(id)}: {`,
      `    ${ratesSource(row)},`,
      `    longContext: { thresholdTokens: ${num(row.longContext.thresholdTokens)}, ${ratesSource(row.longContext)} },`,
      "  },",
    );
  }
  lines.push(
    "};",
    "",
    "/**",
    ' * Fast mode (`speed: "fast"`): the official page lists these models only,',
    " * each at a multiple of its base input and output rate; cache multipliers",
    " * apply on top, so cache rates scale too.",
    " */",
    "const FAST_MODE_MULTIPLIER: Readonly<Record<string, number>> = {",
  );
  for (const [id, factor] of Object.entries(page.fast)) {
    const p = page.fastPrices[id];
    lines.push(`  ${JSON.stringify(id)}: ${num(factor)},${p === undefined ? "" : ` // $${num(p.input)} / $${num(p.output)}`}`);
  }
  lines.push("};", BLOCK_END);
  return lines.join("\n");
}

const DATE_LINE = /^export const ANTHROPIC_OFFICIAL_PRICES_DATE = "\d{4}-\d{2}-\d{2}";$/m;

/** The table file with its generated region and date replaced; throws when either is missing. */
export function rewriteTableFile(source: string, page: Pick<ParsedPage, "prices" | "fast" | "fastPrices">, date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`bad date ${date}`);
  const begin = source.indexOf(BLOCK_BEGIN);
  const end = source.indexOf(BLOCK_END, begin);
  if (begin < 0 || end < 0 || source.indexOf(BLOCK_BEGIN, begin + 1) >= 0) {
    throw new Error("table file: generated block markers missing or repeated");
  }
  if ((source.match(new RegExp(DATE_LINE.source, "gm")) ?? []).length !== 1) {
    throw new Error("table file: ANTHROPIC_OFFICIAL_PRICES_DATE line missing or repeated");
  }
  const replaced = source.slice(0, begin) + renderGeneratedBlock(page) + source.slice(end + BLOCK_END.length);
  return replaced.replace(DATE_LINE, `export const ANTHROPIC_OFFICIAL_PRICES_DATE = ${JSON.stringify(date)};`);
}

// ------------------------------------------------------------------ CLI

export type CliArgs = { write: boolean; source?: string; help: boolean };

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { write: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--write") args.write = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--source") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error("--source needs a file path");
      args.source = value;
    } else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

/** The report printed for a parsed page; `code` is the exit code before any write. */
export function reportCheck(
  page: ParsedPage,
  committed: { prices: CommittedTable; fast: FastTable; date: string },
): { lines: string[]; code: 0 | 1 | 2; diff: TableDiff } {
  const lines: string[] = [];
  if (page.retired.length > 0) lines.push(`skipped (retired): ${page.retired.join("; ")}`);
  for (const u of page.unknown) lines.push(`unknown model name (not mapped, not guessed): ${u}`);
  for (const p of page.problems) lines.push(`cannot parse: ${p}`);
  const diff = diffTables(committed, page);
  for (const a of diff.added) lines.push(`added    ${a}`);
  for (const r of diff.removed) lines.push(`removed  ${r}`);
  for (const c of diff.changed) lines.push(`changed  ${c}`);
  const broken = page.unknown.length > 0 || page.problems.length > 0;
  if (!broken && diffIsEmpty(diff)) {
    lines.push(`the committed table (${committed.date}) matches the official page`);
  }
  return { lines, code: broken ? 2 : diffIsEmpty(diff) ? 0 : 1, diff };
}

async function loadPage(source: string | undefined): Promise<string> {
  if (source !== undefined) {
    const text = await readFile(source, "utf8");
    return /^\s*</.test(text) ? htmlToMarkdown(text) : text;
  }
  const md = await fetch(`${PRICING_PAGE_URL}.md`);
  const type = md.headers.get("content-type") ?? "";
  if (md.ok && !type.includes("html")) return md.text();
  const html = await fetch(PRICING_PAGE_URL);
  if (!html.ok) throw new Error(`${PRICING_PAGE_URL}: HTTP ${html.status}`);
  return htmlToMarkdown(await html.text());
}

async function main(): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\nusage: npm run prices:anthropic [-- --write] [-- --source <saved page>]\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write("usage: npm run prices:anthropic [-- --write] [-- --source <saved page .md or .html>]\n");
    return 0;
  }
  if (args.source === undefined) {
    applyOfflineModeFromConfigFile();
    if (isOfflineNetwork()) {
      process.stderr.write(`offline mode is on: not fetching ${PRICING_PAGE_URL}. Turn it off, or pass --source <saved page>.\n`);
      return 2;
    }
  }
  let page: ParsedPage;
  try {
    page = parsePricingPage(await loadPage(args.source));
  } catch (err) {
    process.stderr.write(`cannot read the pricing page: ${(err as Error).message}\n`);
    return 2;
  }
  const report = reportCheck(page, {
    prices: ANTHROPIC_OFFICIAL_PRICE_ROWS,
    fast: ANTHROPIC_FAST_MODE_MULTIPLIERS,
    date: ANTHROPIC_OFFICIAL_PRICES_DATE,
  });
  process.stdout.write(`${report.lines.join("\n")}\n`);
  if (!args.write) return report.code;
  if (report.code === 2) {
    process.stderr.write("not writing: fix the parse problems or the model-name mapping first\n");
    return 2;
  }
  return writeRefreshedTable(page, new Date().toISOString().slice(0, 10), {
    path: TABLE_PATH,
    readFile: (path) => readFile(path, "utf8"),
    writeFile: (path, text) => writeFile(path, text),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}

/**
 * `--write`: regenerate the table file at `io.path`. 0 when written;
 * {@link PRICES_EXIT_WRITE_FAILED} when it could not be read, rewritten or
 * saved, with the reason on stderr (a rejection would surface as exit 1,
 * the "table differs" verdict).
 */
export async function writeRefreshedTable(
  page: ParsedPage,
  date: string,
  io: {
    path: string;
    readFile(path: string): Promise<string>;
    writeFile(path: string, text: string): Promise<void>;
    stdout(text: string): void;
    stderr(text: string): void;
  },
): Promise<number> {
  try {
    await io.writeFile(io.path, rewriteTableFile(await io.readFile(io.path), page, date));
  } catch (err) {
    io.stderr(`cannot write ${io.path}: ${(err as Error).message}\n`);
    return PRICES_EXIT_WRITE_FAILED;
  }
  io.stdout(`wrote ${io.path} (date ${date}); review the diff\n`);
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main();
}
