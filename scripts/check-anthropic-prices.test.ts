import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ANTHROPIC_FAST_MODE_MULTIPLIERS,
  ANTHROPIC_OFFICIAL_PRICE_ROWS,
} from "../src/llm/provider/official-prices/anthropic-official-prices.js";
import {
  BLOCK_BEGIN,
  BLOCK_END,
  cleanCell,
  diffTables,
  htmlToMarkdown,
  mapModelName,
  parseArgs,
  parsePrice,
  parsePricingPage,
  renderGeneratedBlock,
  reportCheck,
  rewriteTableFile,
  writeRefreshedTable,
  PRICES_EXIT_WRITE_FAILED,
} from "./check-anthropic-prices.js";

// A saved copy of https://platform.claude.com/docs/en/about-claude/pricing.md
// (2026-11-15), trimmed to the two tables the script parses. Never fetched.
const FIXTURE = readFileSync(
  fileURLToPath(new URL("./test-fixtures/anthropic-pricing-2026-11-15.md", import.meta.url)),
  "utf8",
);
const TABLE_FILE = readFileSync(
  fileURLToPath(new URL("../src/llm/provider/official-prices/anthropic-official-prices.ts", import.meta.url)),
  "utf8",
);
const COMMITTED = { prices: ANTHROPIC_OFFICIAL_PRICE_ROWS, fast: ANTHROPIC_FAST_MODE_MULTIPLIERS, date: "2026-11-15" };

describe("cells", () => {
  it("reads prices through footnotes, USD and thousands separators", () => {
    expect(parsePrice("$0.20 / MTok<sup>1</sup>")).toBe(0.2);
    expect(parsePrice("$16 USD / MTok")).toBe(16);
    expect(parsePrice("$1,250.50 / MTok")).toBe(1250.5);
    expect(parsePrice("$12.50 / MTok")).toBe(12.5);
    expect(parsePrice("free")).toBeUndefined();
    expect(parsePrice("$1,25 / MTok")).toBeUndefined();
  });

  it("strips links and markers from names", () => {
    expect(cleanCell("Claude Mythos 5.2 ([limited availability](https://x))")).toBe("Claude Mythos 5.2 (limited availability)");
  });

  it("maps model names to ids, tiers and retired rows, and reports the rest", () => {
    expect(mapModelName("Claude Fable 5.2")).toEqual({ kind: "model", id: "claude-fable-5-2", tier: "base" });
    expect(mapModelName("Claude Opus 5.5")).toEqual({ kind: "model", id: "claude-opus-5-5", tier: "base" });
    expect(mapModelName("Claude Mythos 5 ([limited availability](https://x))")).toEqual({ kind: "model", id: "claude-mythos-5", tier: "base" });
    expect(mapModelName("Claude Haiku 5.5 (for prompts up to 100,000 tokens)")).toEqual({ kind: "model", id: "claude-haiku-5-5", tier: "base" });
    expect(mapModelName("Claude Haiku 5.5 (for prompts over 100,000 tokens)")).toEqual({
      kind: "model", id: "claude-haiku-5-5", tier: "long", thresholdTokens: 100_000,
    });
    expect(mapModelName("Claude Opus 4.1 ([retired, except on Bedrock](https://x))").kind).toBe("retired");
    expect(mapModelName("Claude Poet 6")).toEqual({ kind: "unknown", name: "Claude Poet 6" });
    expect(mapModelName("Claude Opus 6 (preview)")).toEqual({ kind: "unknown", name: "Claude Opus 6 (preview)" });
    expect(mapModelName("Claude Mythos Preview").kind).toBe("unknown");
  });
});

describe("parsePricingPage on the saved official page", () => {
  const page = parsePricingPage(FIXTURE);

  it("parses every live row, skips retired ones and needs no guessing", () => {
    expect(page.problems).toEqual([]);
    expect(page.unknown).toEqual([]);
    expect(page.retired).toHaveLength(3);
    expect(page.prices["claude-fable-5-2"]).toEqual({ input: 8, cacheWrite: 10, cacheRead: 0.2, output: 40 });
    expect(page.prices["claude-haiku-5-5"]).toEqual({
      input: 0.1, cacheWrite: 0.125, cacheRead: 0.01, output: 0.5,
      longContext: { thresholdTokens: 100_000, input: 0.5, cacheWrite: 0.625, cacheRead: 0.05, output: 2.5 },
    });
    expect(page.fast).toEqual({
      "claude-fable-5-2": 2, "claude-mythos-5-2": 2, "claude-opus-5-5": 2, "claude-opus-5": 2, "claude-opus-4-8": 2,
    });
  });

  it("two long-prompt rows for one model are a problem (exit 2), not the last one kept", () => {
    const longRow = FIXTURE.split("\n").find((line) => line.includes("Haiku 5.5 (for prompts over 100,000 tokens)"))!;
    const second = longRow
      .replace("over 100,000 tokens", "over 200,000 tokens")
      .replace("$2.50 / MTok", "$3 / MTok");
    const doubled = FIXTURE.replace(longRow, `${longRow}\n${second}`);
    const parsed = parsePricingPage(doubled);
    expect(parsed.problems).toEqual([
      expect.stringMatching(/claude-haiku-5-5: .*long-prompt rows? listed twice/),
    ]);
    expect(reportCheck(parsed, COMMITTED).code).toBe(2);
  });

  it("matches the committed table: the check exits 0", () => {
    const report = reportCheck(page, COMMITTED);
    expect(report.lines.filter((l) => /^(added|removed|changed|unknown|cannot)/.test(l))).toEqual([]);
    expect(report.code).toBe(0);
  });

  it("reproduces the committed generated block byte for byte", () => {
    const begin = TABLE_FILE.indexOf(BLOCK_BEGIN);
    const end = TABLE_FILE.indexOf(BLOCK_END);
    expect(begin).toBeGreaterThan(0);
    expect(TABLE_FILE.slice(begin, end + BLOCK_END.length)).toBe(renderGeneratedBlock(page));
    expect(rewriteTableFile(TABLE_FILE, page, "2026-11-15")).toBe(TABLE_FILE);
  });

  it("reports an added, a removed and a changed row and exits 1", () => {
    const changed = FIXTURE
      .replace("| Claude Sonnet 4.6    ", "| Claude Sonnet 4.7    ")
      .replace(/(\| Claude Sonnet 5\.5 +\| \$2 \/ MTok +\| \$2\.50 \/ MTok +\| \$4 \/ MTok +\| \$0\.10 \/ MTok<sup>2<\/sup> \| )\$10/, (_m, row: string) => `${row}$12`);
    const report = reportCheck(parsePricingPage(changed), COMMITTED);
    expect(report.diff.added).toEqual([
      "claude-sonnet-4-7: input 3, cacheWrite 3.75, cacheRead 0.3, output 15",
    ]);
    expect(report.diff.removed).toEqual(["claude-sonnet-4-6"]);
    expect(report.diff.changed).toEqual(["claude-sonnet-5-5: output 10 -> 12"]);
    expect(report.code).toBe(1);
  });

  it("reports an unknown model name instead of guessing, and exits 2", () => {
    const report = reportCheck(parsePricingPage(FIXTURE.replace("| Claude Haiku 4.5  ", "| Claude Poem 1     ")), COMMITTED);
    expect(report.lines).toContain("unknown model name (not mapped, not guessed): Claude Poem 1");
    expect(report.code).toBe(2);
  });

  it("flags a fast-mode row whose input and output scale differently", () => {
    const page2 = parsePricingPage(FIXTURE.replace("| $8 USD / MTok  | $40 USD / MTok |", "| $8 USD / MTok  | $60 USD / MTok |"));
    expect(page2.problems).toEqual([expect.stringContaining("fast mode claude-opus-5-5: input and output scale differently")]);
  });
});

describe("rewriteTableFile", () => {
  it("rewrites the rows and the date only", () => {
    const page = parsePricingPage(FIXTURE);
    page.prices["claude-opus-5-5"] = { ...page.prices["claude-opus-5-5"]!, output: 22 };
    const next = rewriteTableFile(TABLE_FILE, page, "2027-03-01");
    expect(next).toContain('export const ANTHROPIC_OFFICIAL_PRICES_DATE = "2027-03-01";');
    expect(next).toContain('"claude-opus-5-5": { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 22 },');
    const outside = (s: string) => s.slice(0, s.indexOf(BLOCK_BEGIN)).replace(/"\d{4}-\d{2}-\d{2}"/, "D") + s.slice(s.indexOf(BLOCK_END));
    expect(outside(next)).toBe(outside(TABLE_FILE));
  });

  it("a failed write exits with its own code, not 1 (\"the table differs\")", async () => {
    expect(PRICES_EXIT_WRITE_FAILED).toBe(4);
    const errors: string[] = [];
    const code = await writeRefreshedTable(parsePricingPage(FIXTURE), "2027-03-01", {
      path: "/nowhere/anthropic-official-prices.ts",
      readFile: async () => TABLE_FILE,
      writeFile: async () => {
        throw new Error("EACCES: permission denied");
      },
      stdout: () => undefined,
      stderr: (line) => errors.push(line),
    });
    expect(code).toBe(4);
    expect(errors.join("")).toMatch(/cannot write .*EACCES/);
  });

  it("a successful write exits 0", async () => {
    let written = "";
    const code = await writeRefreshedTable(parsePricingPage(FIXTURE), "2027-03-01", {
      path: "/t.ts",
      readFile: async () => TABLE_FILE,
      writeFile: async (_p, text) => {
        written = text;
      },
      stdout: () => undefined,
      stderr: () => undefined,
    });
    expect(code).toBe(0);
    expect(written).toContain('"2027-03-01"');
  });

  it("refuses a file without its markers", () => {
    expect(() => rewriteTableFile("const PRICES = {};", parsePricingPage(FIXTURE), "2027-03-01")).toThrow(/markers/);
  });
});

describe("htmlToMarkdown", () => {
  it("turns the HTML page's headings and tables into the shape the parser reads", () => {
    const html = `<h2 id="model-pricing">Model pricing</h2><p>x</p><table><thead><tr><th>Model</th><th>Base input tokens</th>
      <th>5m cache writes</th><th>1h cache writes</th><th>Cache hits and refreshes</th><th>Output tokens</th></tr></thead>
      <tbody><tr><td>Claude Opus 5.5</td><td>&#36;4 / MTok</td><td>$5 / MTok</td><td>$8 / MTok</td><td>$0.20 / MTok<sup>2</sup></td><td>$20 / MTok</td></tr></tbody></table>
      <h3>Fast mode pricing</h3><table><tr><th>Model</th><th>Input</th><th>Output</th></tr>
      <tr><td><a href="x">Claude Opus 5.5</a></td><td>$8 USD / MTok</td><td>$40 USD / MTok</td></tr></table>`;
    const page = parsePricingPage(htmlToMarkdown(html));
    expect(page.problems).toEqual([]);
    expect(page.prices).toEqual({ "claude-opus-5-5": { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 } });
    expect(page.fast).toEqual({ "claude-opus-5-5": 2 });
  });
});

describe("parseArgs", () => {
  it("reads --write and --source, and rejects the rest", () => {
    expect(parseArgs([])).toEqual({ write: false, help: false });
    expect(parseArgs(["--write", "--source", "p.md"])).toEqual({ write: true, help: false, source: "p.md" });
    expect(() => parseArgs(["--source"])).toThrow(/file path/);
    expect(() => parseArgs(["--force"])).toThrow(/unknown argument/);
  });

  it("diffs nothing between identical tables", () => {
    expect(diffTables(COMMITTED, COMMITTED)).toEqual({ added: [], removed: [], changed: [] });
  });
});
