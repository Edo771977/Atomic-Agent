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
