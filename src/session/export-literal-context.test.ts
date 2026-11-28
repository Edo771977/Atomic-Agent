import { inflateSync } from "node:zlib";
import { Worker } from "node:worker_threads";
import { Marked } from "marked";
import JSZip from "jszip";
import { decodeHTML } from "entities";
import { expect, it } from "vitest";
import { exportChat } from "./chat-export-render.js";
import { createEmptySessionState } from "./session-state.js";

const contexts = [
  ["bulleted", "- parent\n  - nested\n    - child\n      - leaf\n\n"],
  ["ordered", "1. parent\n   1. nested\n      1. child\n         1. leaf\n\n"],
] as const;
function chat(text: string) {
  const state = createEmptySessionState({ id: "literal", workingDir: "/fixture", metadata: { title: "Fixture" } });
  state.turns.push({ kind: "user", text, at: 1 });
  return state;
}
function pdfText(bytes: Buffer): string {
  let out = "";
  for (const m of bytes.toString("latin1").matchAll(/<< \/Length (\d+) \/Filter \/FlateDecode >>\nstream\n/g)) {
    const start = m.index! + m[0].length;
    const stream = inflateSync(bytes.subarray(start, start + Number(m[1]))).toString("latin1");
    out += [...stream.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].map(m => m[1]!.replace(/\\([()\\])/g, "$1")).join("");
  }
  return out;
}

for (const format of ["markdown", "html", "pdf"] as const) {
  for (const innerFence of [false, true]) {
    it.each(contexts)(`${format} keeps oversized fallback literal after %s lists (inner fence=${innerFence})`, async (_name, prefix) => {
      const body = "[x](".repeat(800) + (innerFence ? "\n```````\nsafe\n```````\n" : " ") + "**INERT**";
      const file = await exportChat(chat(prefix + body), format, { knownSecrets: [], now: 1 });
      const shown = format === "pdf" ? pdfText(file.body as Buffer)
        : format === "markdown" ? new Marked().parse(String(file.body), { async: false }) : String(file.body);
      expect(shown).not.toContain("<strong>INERT</strong>");
      expect(shown).toContain("**INERT**");
    });
  }
}

// A regression must fail on time rather than trap the test runner in a
// synchronous Markdown parser. Startup is excluded from the rendering budget.
async function workerRender(format: "html" | "pdf", text: string): Promise<number> {
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    (async () => {
      const { tsImport } = await import("tsx/esm/api");
      const { exportChat } = await tsImport(workerData.module, workerData.module);
      const { createEmptySessionState } = await tsImport(workerData.stateModule, workerData.module);
      const state = createEmptySessionState({ id: "literal", workingDir: "/fixture", metadata: { title: "Fixture" } });
      state.turns.push({ kind: "user", text: workerData.text, at: 1 });
      const start = performance.now();
      await exportChat(state, workerData.format, { knownSecrets: [], now: 1 });
      parentPort.postMessage(performance.now() - start);
    })().catch(error => { throw error; });
  `, { eval: true, execArgv: ["--import", "tsx"], workerData: {
    format, text, module: new URL("./chat-export-render.ts", import.meta.url).href,
    stateModule: new URL("./session-state.ts", import.meta.url).href,
  } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<number>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("render worker exceeded five-second deadline")), 5_000);
      worker.once("message", resolve);
      worker.once("error", reject);
    });
  } finally { clearTimeout(timer); await worker.terminate(); }
}

const openContexts = [
  ["comment", "<!--", "-->"],
  ["pre", "<pre>", "</pre>"],
  ["script", "<script>", "</script>"],
  ["style", "<style>", "</style>"],
  ["textarea", "<textarea>", "</textarea>"],
  ["CDATA", "<![CDATA[", "]]>"],
  ["processing instruction", "<?fixture", "?>"],
  ["declaration", "<!DOCTYPE fixture [", "]>"],
  ["backtick fence", "```fixture", "```"],
  ["tilde fence", "~~~fixture", "~~~"],
] as const;
const vendor = "sk-proj-abcDEFghijkLMN0123456789abcdEF";
function contextualChat(opening: string, body: string, closing: string, mode: string) {
  const prefix = mode === "budget" ? "[ordinary](https://example.invalid)\n\n".repeat(1_100)
    : mode === "inside block" ? "leading paragraph\n" : "";
  if (mode === "unclosed") closing = "";
  const state = chat(prefix + opening + "\n\n" + body + "\n" + closing);
  if (mode === "previous turn") state.turns = [
    { kind: "user", text: opening, at: 1 },
    { kind: "assistant_reply", text: body + "\n" + closing, at: 2 },
  ];
  return state;
}
async function rendered(format: "markdown" | "html" | "pdf" | "docx", body: string | Buffer): Promise<string> {
  if (format === "pdf") return pdfText(body as Buffer);
  if (format === "docx") {
    const zip = await JSZip.loadAsync(body);
    return decodeHTML((await zip.file("word/document.xml")!.async("string")).replace(/<[^>]*>/g, ""));
  }
  const html = format === "markdown" ? new Marked().parse(String(body), { async: false }) : String(body);
  return decodeHTML(html.replace(/<!--[\s\S]*?-->|<[^>]*>/g, ""));
}
for (const format of ["markdown", "html", "docx", "pdf"] as const) {
  for (const mode of ["large", "previous turn", "budget", "inside block", "unclosed"]) {
    it.each(openContexts)(`${format} contains the entire open %s context in literal fallback (${mode})`, async (_name, opening, closing) => {
      const body = (mode === "budget" ? "" : "[x](".repeat(600)) + "\nLITERAL_PAYLOAD **INERT**";
      const file = await exportChat(contextualChat(opening, body, closing, mode), format, { knownSecrets: [], now: 1 });
      const shown = await rendered(format, file.body);
      expect(shown).toContain(opening);
      if (mode !== "unclosed") expect(shown).toContain(closing);
      expect(shown).toContain("LITERAL_PAYLOAD **INERT**");
      if (format === "html") {
        const code = [...String(file.body).matchAll(/<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/g)].map(m => decodeHTML(m[1]!));
        expect(code.some(text => text.includes(opening) && text.includes("LITERAL_PAYLOAD"))).toBe(true);
      }
    });
  }
  it.each(openContexts)(`${format} masks a vendor shape inside open %s without known values`, async (_name, opening, closing) => {
    const body = "[x](".repeat(600) + "\nsk-proj-abcDEF**ghijkLMN0123456789abcdEF**";
    const file = await exportChat(contextualChat(opening, body, closing, "previous turn"), format, { knownSecrets: [], now: 1 });
    const shown = await rendered(format, file.body);
    expect(shown).not.toContain(vendor);
    expect(shown).toContain("redacted");
  });
}
for (const format of ["html", "pdf"] as const) {
  it.each(openContexts)(`${format} renders one million characters with an open %s within two seconds`, async (name, opening, closing) => {
    const elapsedMs = await workerRender(format, opening + "\n\n" + "[x](".repeat(250_000) + "\n" + closing + "\n\n**AFTER**");
    console.info("EXPORT_CONTEXT_MILLION " + JSON.stringify({ format, context: name, elapsedMs }));
    expect(elapsedMs).toBeLessThan(2_000);
  });
}
for (const format of ["html", "pdf"] as const) {
  it.each(contexts)(`${format} renders one million literal characters after %s lists within two seconds`, async (name, prefix) => {
    const elapsedMs = await workerRender(format, prefix + "[x](".repeat(250_000) + " **INERT**");
    console.info("EXPORT_LITERAL_MILLION " + JSON.stringify({ format, context: name, elapsedMs }));
    expect(elapsedMs).toBeLessThan(2_000);
  });
}
