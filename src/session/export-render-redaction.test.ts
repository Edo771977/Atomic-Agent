import { inflateSync } from "node:zlib";
import JSZip from "jszip";
import { expect, it } from "vitest";
import { createEmptySessionState } from "./session-state.js";
import { exportChat } from "./chat-export-render.js";
import { renderMarkdownPdf } from "./chat-export-pdf.js";

const secret = "sentinel_731key";
const fullwidth = (value: string) => [...value].map(c => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join("");
const variants = [
  ["invisible", "sentinel_\u200b731key"],
  ["fullwidth", fullwidth(secret)],
  ["escape", "sentinel\\_731key"],
  ["emphasis", "sentinel_**731**key"],
  ["code span", "sentinel_`731`key"],
  ["code block encoding", "```\nsentinel_\u0001731key\n```"],
] as const;

async function visible(format: "html" | "docx" | "pdf", body: string | Buffer): Promise<string> {
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

for (const format of ["pdf", "html", "docx"] as const) {
  it.each(variants)(`${format} never reconstructs a known secret through %s`, async (_name, text) => {
    const state = createEmptySessionState({ id: "fixture", workingDir: "/fixture" });
    state.turns.push({ kind: "user", text, at: 1 });
    const file = await exportChat(state, format, { knownSecrets: [{ label: "fixture", value: secret }] });
    const shown = (await visible(format, file.body)).normalize("NFKC").replace(/[\p{Default_Ignorable_Code_Point}\p{Cc}]/gu, "");
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
