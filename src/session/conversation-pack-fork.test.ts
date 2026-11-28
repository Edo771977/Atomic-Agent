import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compressToolResult } from "../compressor/result-compressor.js";
import { buildPrompt } from "../prompt/build-prompt.js";
import type { BuildPromptInput } from "../prompt/build-prompt-types.js";
import { packedConversationTurns } from "../prompt/build-prompt-world-conversation.js";
import { estimateTokens } from "../prompt/token-budget.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { FULL_OUTPUT_PATH_DETAIL, ToolOutputSpill } from "../tools/tool-output-spill.js";
import { createEmptySessionState } from "./session-state.js";
import {
  assistantToolCallTurn, packConversation, renderToolResultBody,
  toolResultTurn, userTurn, type ConversationTurn,
} from "./conversation-turn.js";

const body = Array.from({ length: 2_000 }, (_, i) => `row ${i}: ${"data ".repeat(12)}`).join("\n");
const resultFor = (tool: string, summary = body) => toolResultTurn({ tool, summary, status: "ok", at: 3 });
const task = (result: ConversationTurn): ConversationTurn[] => [
  userTurn("inspect the result", 1),
  assistantToolCallTurn({ tool: result.kind === "tool_result" ? result.tool : "os.fs.read", args: {}, at: 2 }),
  result,
];

describe("W2 packer preserves fork retention", () => {
  it("retains exact paging offsets and full hidden-line counts through a second read cut", () => {
    const turns = [
      userTurn("inspect both files", 1),
      assistantToolCallTurn({ tool: "os.fs.read", args: { path: "a.txt", offset: 101 }, at: 2 }),
      assistantToolCallTurn({ tool: "os.fs.read", args: { path: "b.txt", offset: 501 }, at: 3 }),
      resultFor("os.fs.read"), resultFor("os.fs.read"),
    ];
    const rendered = packedConversationTurns(packConversation(turns, 2_000));
    for (const [index, start] of [[3, 101], [4, 501]] as const) {
      const result = rendered[index];
      if (result?.kind !== "tool_result") throw new Error("missing read");
      const shown = Number(/first (\d+) lines/.exec(result.body)?.[1]);
      const hidden = Number(/(\d+) more lines/.exec(result.body)?.[1]);
      expect(shown).toBeGreaterThan(0);
      expect(result.body).toContain(`offset: ${start + shown}`);
      expect(shown + hidden).toBe(2_000);
    }
  });

  it.each([500, 1_000, 2_000])("keeps the shell spill pointer in the prompt at budget %s", async (budget) => {
    const base = mkdtempSync(join(tmpdir(), "w2-pack-spill-pointer-"));
    try {
      const registry = new ToolRegistry({ outputSpill: new ToolOutputSpill({ baseDir: base }) });
      registry.register({ name: "os.shell.run", description: "fixture", readonly: false,
        run: async () => compressToolResult({ tool: "os.shell.run", status: "ok", output: body }, { maxSummaryLength: 5_000, maxTailLines: 2_000 }),
      });
      const result = await registry.invoke("os.shell.run", {}, {
        workingDir: base, sessionId: "w2-spill-pointer", stepIndex: 0,
        signal: new AbortController().signal, modelMode: "local",
      });
      const path = result.details[FULL_OUTPUT_PATH_DETAIL] as string;
      expect(path).toBeTruthy();
      expect(result.summary.length).toBeLessThan(8_000);
      const spillNote = result.summary.split("\n")[0]!;
      const turns = task(resultFor("os.shell.run", result.summary));
      const packed = packConversation(turns, budget);
      const rendered = packedConversationTurns(packed)[2];
      if (rendered?.kind !== "tool_result") throw new Error("missing result");
      expect(rendered.body).toContain(spillNote);
      expect(rendered.body).toContain(path);
      expect(rendered.body).not.toContain("repeat the call");
      expect(rendered.body.length).toBeLessThanOrEqual(result.summary.length);
      expect(turns[2]?.kind === "tool_result" && turns[2].summary).toBe(result.summary);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it("never expands a short body when the truncation note would cost more than it saves", () => {
    const original = resultFor("os.http.request", "x".repeat(250));
    if (original.kind !== "tool_result") throw new Error("fixture");
    const bounded = packConversation(task(original), 50).visibleTurns[2];
    if (bounded?.kind !== "tool_result") throw new Error("missing result");
    const before = renderToolResultBody(original, { inCurrentMacroTurn: true });
    const after = renderToolResultBody(bounded, { inCurrentMacroTurn: true });
    expect(after.length).toBeLessThanOrEqual(before.length);
    expect(estimateTokens(after)).toBeLessThanOrEqual(estimateTokens(before));
  });

  it("only removes payload already visible under each tool's renderer", () => {
    for (const tool of ["os.http.request", "os.fs.read", "os.shell.run", "fusion.delegate", "os.web.fetch"]) {
      for (const summary of [body, `$ gog mail list\n${body}`]) {
        for (const budget of [100, 500, 2_000, 8_000]) {
          const original = resultFor(tool, summary);
          if (original.kind !== "tool_result") throw new Error("fixture");
          const before = renderToolResultBody(original, { inCurrentMacroTurn: true });
          const packed = packConversation(task(original), budget).visibleTurns[2];
          if (packed?.kind !== "tool_result") throw new Error("missing result");
          const after = renderToolResultBody(packed, { inCurrentMacroTurn: true });
          expect(after.length, `${tool}/${budget}`).toBeLessThanOrEqual(before.length);
          expect(estimateTokens(after), `${tool}/${budget}`).toBeLessThanOrEqual(estimateTokens(before));
          // Row contents beyond an existing head/tail cap must not reappear.
          for (const row of after.matchAll(/row \d+: data/g)) expect(before).toContain(row[0]);
        }
      }
    }
  });

  it("keeps repeated reads as pointers after bounding their first visible copy", () => {
    const first = { ...resultFor("os.fs.read"), read: {
      path: "/work/a.txt", contentHash: "same", startLine: 1, endLine: 2_000, numbered: false,
    } };
    const turns = [...task(first), assistantToolCallTurn({ tool: "os.fs.read", args: {}, at: 4 }), { ...first, at: 5 }];
    const packed = packConversation(turns, 1_000);
    const rendered = packedConversationTurns(packed);
    const repeated = rendered[4];
    expect(repeated?.kind === "tool_result" && repeated.body).toContain("unchanged since your earlier read");
    expect(JSON.stringify(rendered).length).toBeLessThan(4_000);
  });

  it.each([false, true])("bounds the prompt with incognito=%s while preserving existing spill behavior", async (incognito) => {
    const base = mkdtempSync(join(tmpdir(), "w2-pack-spill-"));
    try {
      const registry = new ToolRegistry({ outputSpill: new ToolOutputSpill({ baseDir: base }) });
      registry.register({ name: "os.shell.run", description: "fixture", readonly: false,
        run: async () => compressToolResult({ tool: "os.shell.run", status: "ok", output: body }, { maxSummaryLength: 12_000, maxTailLines: 2_000 }),
      });
      const result = await registry.invoke("os.shell.run", {}, {
        workingDir: base, sessionId: "w2-spill", stepIndex: 0,
        signal: new AbortController().signal, modelMode: "local", incognito,
      });
      const filesBefore = readdirSync(base, { recursive: true });
      const turns = task(resultFor("os.shell.run", result.summary));
      const packed = packConversation(turns, 1_000);
      const visible = packed.visibleTurns[2];
      expect(visible?.kind === "tool_result" && visible.summary.length).toBeLessThan(result.summary.length);
      expect(readdirSync(base, { recursive: true })).toEqual(filesBefore);
      expect(turns[2]?.kind === "tool_result" && turns[2].summary).toBe(result.summary);
      if (incognito) {
        expect(result.details[FULL_OUTPUT_PATH_DETAIL]).toBeUndefined();
        expect(filesBefore).toEqual([]);
      } else {
        expect(readFileSync(result.details[FULL_OUTPUT_PATH_DETAIL] as string, "utf8")).toBe(body);
      }
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it("changes only conversation while stable prefix and following mutable sections keep their order", () => {
    const session = createEmptySessionState({ id: "w2-prefix", workingDir: "/work" });
    const input: BuildPromptInput = {
      session: { ...session, turns: task(resultFor("os.http.request")),
        recalledLessons: [{ id: 42, activation: "Keep the output", tags: [], workingDir: null, updatedAt: 1 }] },
      capabilities: { platform: "linux", arch: "x64", workingDir: "/work", browserChannel: "chrome", hasClipboard: false, hasWmctrl: false, hasNotifications: false },
      toolDescriptors: [], skillCatalog: [], tokenBudget: 100_000,
      modelMode: { mode: "local", source: "legacy", providerId: "local", modelId: null },
    };
    const wide = buildPrompt({ ...input, conversationMaxTokens: 90_000 });
    const bounded = buildPrompt({ ...input, conversationMaxTokens: 2_000 });
    expect(Buffer.from(bounded.stablePrefix)).toEqual(Buffer.from(wide.stablePrefix));
    expect(bounded.tokens.conversation).toBeLessThanOrEqual(2_000);
    expect(bounded.tokens.conversation).toBeLessThan(wide.tokens.conversation);
    expect(bounded.tail.indexOf("### lessons")).toBeGreaterThan(bounded.tail.indexOf("### conversation"));
  });
});
