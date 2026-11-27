import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { Lexer } from "marked";
import { exportChat } from "./chat-export-render.js";
import { createEmptySessionState } from "./session-state.js";
import { maskChatExportText } from "./chat-export.js";

afterEach(() => vi.restoreAllMocks());

const options = { now: 1, knownSecrets: [{ label: "fixture", value: "sentinel_731key" }] };
const mainPath = process.env.ATOMIC_AGENT_EXPORT_MAIN_MODULE;
const main = mainPath ? await import(pathToFileURL(mainPath).href) as { exportChat: typeof exportChat } : null;
const median = (times: number[]) => [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)]!;
function chat(text: string) {
  const state = createEmptySessionState({ id: "budget", workingDir: "/fixture", metadata: { title: "Fixture" } });
  state.turns.push({ kind: "user", text, at: 1 });
  return state;
}

for (const format of ["markdown", "html", "pdf"] as const) {
  it.each(["[x](".repeat(12_000), "*_`~".repeat(12_000)])(`${format} bounds repeated link/delimiter syntax (%#)`, async text => {
    const state = chat(text);
    const start = performance.now();
    await exportChat(state, format, options);
    const elapsed = performance.now() - start;
    let mainElapsed = 0;
    if (main) {
      const before = performance.now();
      await main.exportChat(state, format, options);
      mainElapsed = performance.now() - before;
      console.info("EXPORT_PERF " + JSON.stringify({ format, kind: text.startsWith("[") ? "links" : "delimiters", elapsedMs: elapsed, mainMs: mainElapsed }));
    }
    expect(elapsed).toBeLessThan(Math.max(2_000, mainElapsed * 1.3));
  }, 60_000);
}

it.skipIf(!main)("exports 1000 ordinary turn pairs within 1.3 times main", async () => {
  const state = chat("");
  state.turns = Array.from({ length: 1000 }, (_, i) => [
    { kind: "user" as const, text: `Ordinary question ${i} about the current work`, at: i },
    { kind: "assistant_reply" as const, text: `Ordinary answer ${i} with a concise explanation`, at: i },
  ]).flat();
  for (let i = 0; i < 2; i += 1) { await main!.exportChat(state, "markdown", options); await exportChat(state, "markdown", options); }
  const baseline: number[] = [], current: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    let start = performance.now();
    const original = await main!.exportChat(state, "markdown", options);
    baseline.push(performance.now() - start);
    start = performance.now();
    const result = await exportChat(state, "markdown", options);
    current.push(performance.now() - start);
    expect(result.body).toBe(original.body);
  }
  const ratio = median(current) / median(baseline);
  console.info("EXPORT_PERF " + JSON.stringify({ format: "markdown", kind: "ordinary-1000-pairs", elapsedMs: median(current), mainMs: median(baseline), ratio }));
  expect(ratio).toBeLessThanOrEqual(1.3);
});

it("bounds each parser input and total parsing work instead of lexing the document", () => {
  const lex = vi.spyOn(Lexer, "lex");
  maskChatExportText(Array.from({ length: 2_000 }, () => "[ordinary](https://example.invalid)").join("\n\n"), options);
  const lengths = lex.mock.calls.map(call => call[0].length);
  expect(lengths.every(length => length <= 2_048)).toBe(true);
  expect(lengths.reduce((sum, length) => sum + length, 0)).toBeLessThanOrEqual(32_768);
});
it("redacts a possible joined secret when a block exceeds parser work limits", () => {
  const result = maskChatExportText("[sentinel](/label)_731key ".repeat(200), options);
  expect(result).toContain("redacted");
  expect(result).not.toContain("sentinel_731key");
});
it("conservatively matches reference-label keys containing surrogate pairs", () => {
  const result = maskChatExportText("[sentinel][ref]_731🔐key\n\n[ref]: https://example.invalid", {
    knownSecrets: [{ label: "fixture", value: "sentinel_731🔐key" }],
  });
  expect(result).toContain("redacted");
});
