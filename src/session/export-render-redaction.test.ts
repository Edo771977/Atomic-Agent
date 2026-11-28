import { inflateSync } from "node:zlib";
import JSZip from "jszip";
import { decodeHTML } from "entities";
import { Marked } from "marked";
import { expect, it } from "vitest";
import { createEmptySessionState } from "./session-state.js";
import { exportChat } from "./chat-export-render.js";
import { renderMarkdownPdf } from "./chat-export-pdf.js";
import { renderChatHtml } from "./chat-export.js";

const secret = "sentinel_731key";
const fullwidth = (value: string) => [...value].map(c => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join("");
const variants = [
  ["decimal entity", "sentinel&#95;731key"],
  ["hex entity", "sentinel&#x5f;731key"],
  ["named entity", "sentinel&lowbar;731key"],
  ["NBSP entity", "sentinel_&nbsp;731key"],
  ["decimal NBSP entity", "sentinel_&#160;731key"],
  ["hex NBSP entity", "sentinel_&#xa0;731key"],
  ["literal NBSP", "sentinel_\u00a0731key"],
  ["initial entity", "&#115;entinel_731key"],
  ["escaped decimal entity", "sentinel&amp;#95;731key"],
  ["escaped hex entity", "sentinel&amp;#x5f;731key"],
  ["escaped named entity", "sentinel&amp;lowbar;731key"],
  ["escaped initial entity", "&amp;#115;entinel_731key"],
  ["underscore link label", "sentinel[_](https://example.invalid)731key"],
  ["prefix link label", "[sentinel](https://example.invalid)_731key"],
  ["reference link label", "[sentinel][ref]_731key\n\n[ref]: https://example.invalid"],
  ["invisible", "sentinel_\u200b731key"],
  ["fullwidth", fullwidth(secret)],
  ["escape", "sentinel\\_731key"],
  ["emphasis", "sentinel_**731**key"],
  ["code span", "sentinel_`731`key"],
  ["trimmed code suffix", "sentinel_` 731key `"],
  ["trimmed code prefix", "` sentinel_ `731key"],
  ["trimmed code with surrounding text", "before sentinel_` 731key ` after"],
  ["space hard break", "sentinel_  \n731key"],
  ["backslash hard break", "sentinel_\\\n731key"],
  ["adjacent header cells", "| sentinel_ | 731key |\n| --- | --- |\n| safe | safe |"],
  ["adjacent body cells", "| a | b |\n| --- | --- |\n| sentinel_ | 731key |"],
  ["code block encoding", "```\nsentinel_\u0001731key\n```"],
] as const;

async function visible(format: "markdown" | "html" | "docx" | "pdf", body: string | Buffer): Promise<string> {
  if (format === "markdown") return new Marked().parse(String(body), { async: false }).replace(/<[^>]*>/g, "");
  if (format === "docx") {
    const zip = await JSZip.loadAsync(body);
    return (await zip.file("word/document.xml")!.async("string")).replace(/<[^>]*>/g, "");
  }
  if (format === "html") return String(body).replace(/<[^>]*>/g, "");
  const bytes = body as Buffer;
  let out = "";
  for (const m of bytes.toString("latin1").matchAll(/<< \/Length (\d+) \/Filter \/FlateDecode >>\nstream\n/g)) {
    const start = m.index! + m[0].length;
    const stream = inflateSync(bytes.subarray(start, start + Number(m[1]))).toString("latin1");
    out += [...stream.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].map(m => m[1]!.replace(/\\([()\\])/g, "$1")).join("");
  }
  return out;
}

for (const format of ["markdown", "pdf", "html", "docx"] as const) {
  it.each([
    ["GitHub control", "ghp_AbcD\u0000EFghijkLMN0123456789abcdEFGH", "ghp_AbcDEFghijkLMN0123456789abcdEFGH"],
    ["GitHub XML noncharacter", "ghp_AbcD\ufffeEFghijkLMN0123456789abcdEFGH", "ghp_AbcDEFghijkLMN0123456789abcdEFGH"],
    ["GitHub emphasis", "ghp_AbcD**EFghijkLMN0123456789abcdEFGH**", "ghp_AbcDEFghijkLMN0123456789abcdEFGH"],
    ["GitHub emphasis and control", "ghp_AbcD**EFghi\u0001jkLMN0123456789abcdEFGH**", "ghp_AbcDEFghijkLMN0123456789abcdEFGH"],
    ["named HTTP token", "atag_" + "x".repeat(10) + "\u200b" + "x".repeat(33), "atag_" + "x".repeat(43)],
  ])(`${format} preserves structural underscores in projected detector prefixes: %s`, async (_name, text, sentinel) => {
    const state = createEmptySessionState({ id: "fixture", workingDir: "/fixture", metadata: { title: "Fixture" } });
    state.turns.push({ kind: "user", text, at: 1 });
    const file = await exportChat(state, format, { knownSecrets: [] });
    const shown = decodeHTML(await visible(format, file.body)).normalize("NFKC")
      .replace(/[\p{Default_Ignorable_Code_Point}\p{Cc}\ufffe\uffff]/gu, "");
    expect(shown).not.toContain(sentinel);
    expect(shown).toContain("redacted");
    if (format === "docx") {
      const zip = await JSZip.loadAsync(file.body);
      expect(await zip.file("word/document.xml")!.async("string")).not.toContain(sentinel);
    }
  });
  it.each([
    ["NUL", "sk-proj-abcDEF\u0000ghijkLMN0123456789abcdEF"],
    ["SOH", "sk-proj-abcDEF\u0001ghijkLMN0123456789abcdEF"],
    ["XML noncharacter FFFE", "sk-proj-abcDEF\ufffeghijkLMN0123456789abcdEF"],
    ["XML noncharacter FFFF", "sk-proj-abcDEF\uffffghijkLMN0123456789abcdEF"],
    ["zero-width space", "sk-proj-abcDEF\u200bghijkLMN0123456789abcdEF"],
    ["word joiner", "sk-proj-abcDEF\u2060ghijkLMN0123456789abcdEF"],
    ["compatibility forms", fullwidth("sk-proj-abcDEFghijkLMN0123456789abcdEF")],
  ])(`${format} projects small vendor-shaped text without known values: %s`, async (_name, text) => {
    const state = createEmptySessionState({ id: "fixture", workingDir: "/fixture", metadata: { title: "Fixture" } });
    state.turns.push({ kind: "user", text, at: 1 });
    const file = await exportChat(state, format, { knownSecrets: [] });
    const shown = decodeHTML(await visible(format, file.body)).normalize("NFKC")
      .replace(/[\p{Default_Ignorable_Code_Point}\p{Cc}]/gu, "");
    expect(shown).not.toContain("sk-proj-abcDEFghijkLMN0123456789abcdEF");
    expect(shown).toContain("redacted");
    if (format === "docx") {
      const zip = await JSZip.loadAsync(file.body);
      const xml = await zip.file("word/document.xml")!.async("string");
      expect(xml).not.toContain("sk-proj-abcDEFghijkLMN0123456789abcdEF");
      expect(xml).toContain("redacted");
    }
  });
  it.each([
    ["trimmed code suffix", "sk-proj-` abcDEFghijkLMN0123456789abcdEF `"],
    ["trimmed code prefix", "` sk-proj- `abcDEFghijkLMN0123456789abcdEF"],
    ["surrounding text", "before sk-proj-` abcDEFghijkLMN0123456789abcdEF ` after"],
    ["space hard break", "sk-proj-  \nabcDEFghijkLMN0123456789abcdEF"],
    ["backslash hard break", "sk-proj-\\\nabcDEFghijkLMN0123456789abcdEF"],
    ["adjacent cells", "| a | b |\n| --- | --- |\n| sk-proj- | abcDEFghijkLMN0123456789abcdEF |"],
  ])(`${format} detects a rendered vendor sentinel without known values: %s`, async (_name, text) => {
    const state = createEmptySessionState({ id: "fixture", workingDir: "/fixture" });
    state.turns.push({ kind: "user", text, at: 1 });
    const file = await exportChat(state, format, { knownSecrets: [] });
    const shown = decodeHTML(await visible(format, file.body));
    expect(shown).not.toContain("sk-proj-abcDEFghijkLMN0123456789abcdEF");
    expect(shown).toContain("redacted");
  });
  it(`${format} masks a known value with an escaped hyphen`, async () => {
    const value = "sentinel-731key";
    const state = createEmptySessionState({ id: "fixture", workingDir: "/fixture" });
    state.turns.push({ kind: "user", text: "sentinel\\-731key", at: 1 });
    const file = await exportChat(state, format, { knownSecrets: [{ label: "fixture", value }] });
    const shown = decodeHTML(await visible(format, file.body));
    expect(shown).not.toContain(value);
    expect(shown).toContain("redacted");
  });
  it.each(variants)(`${format} never reconstructs a known secret through %s`, async (_name, text) => {
    const state = createEmptySessionState({ id: "fixture", workingDir: "/fixture" });
    state.turns.push({ kind: "user", text, at: 1 });
    const file = await exportChat(state, format, { knownSecrets: [{ label: "fixture", value: secret }] });
    const shown = decodeHTML(decodeHTML(await visible(format, file.body))).normalize("NFKC").replace(/[\p{Default_Ignorable_Code_Point}\p{Cc}]/gu, "");
    expect(shown).not.toContain(secret);
    expect(shown).toContain("redacted");
  });
}

it.each(["vaultL**oNg**731", "```\nvaultLoNg731\n```"])("PDF masks final encoded text before wrapping: %s", async markdown => {
  const pdf = renderMarkdownPdf(markdown, "fixture", 1, { knownSecrets: [{ label: "fixture", value: "vaultŁoNg731" }] });
  const shown = await visible("pdf", pdf);
  expect(shown).not.toContain("vaultLoNg731");
  expect(shown).toContain("redacted");
});

it.each([
  "Authorization: Bearer ABCD**EFghijkLMN0123456789abcdEF**",
  "Authorization: Bearer ABCD`EFghijkLMN0123456789abcdEF`",
  "Authorization: Bearer A&#66;CDEFghijkLMN0123456789abcdEF",
  "Authorization: [Bearer][ref] ABCDEFghijkLMN0123456789abcdEF\n\n[ref]: https://example.invalid",
])("HTML preserves normal credential detection after parsing: %s", async markdown => {
  const shown = await visible("html", renderChatHtml(markdown, "fixture", { knownSecrets: [] }));
  expect(decodeHTML(shown)).not.toContain("ABCDEFghijkLMN0123456789abcdEF");
  expect(shown).toContain("redacted");
});

it.each([
  "# sentinel[_](/label)731key",
  "> sentinel[_](/label)731key",
  "- sentinel[_](/label)731key",
  "| Header |\n| --- |\n| sentinel[_](/label)731key |",
])("HTML checks joined labels in each block type: %s", async markdown => {
  const shown = await visible("html", renderChatHtml(markdown, "fixture", { knownSecrets: [{ label: "fixture", value: secret }] }));
  expect(shown).not.toContain(secret);
  expect(shown).toContain("redacted");
});
