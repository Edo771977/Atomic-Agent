import { inflateSync } from "node:zlib";
import { Worker } from "node:worker_threads";
import { Marked } from "marked";
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
for (const format of ["html", "pdf"] as const) {
  it.each(contexts)(`${format} renders one million literal characters after %s lists within two seconds`, async (name, prefix) => {
    const elapsedMs = await workerRender(format, prefix + "[x](".repeat(250_000) + " **INERT**");
    console.info("EXPORT_LITERAL_MILLION " + JSON.stringify({ format, context: name, elapsedMs }));
    expect(elapsedMs).toBeLessThan(2_000);
  });
}
