import { describe, expect, it } from "vitest";

import type { CompletionResult } from "../src/llm/provider/completion-types.js";
import { anthropicOfficialPricing } from "../src/llm/provider/official-prices/anthropic-official-prices.js";
import {
  DEFAULT_MODEL,
  TOOL_NAME,
  cacheableSystemPrompt,
  checkBudget,
  evaluateCache,
  evaluateEffort,
  evaluateToolCall,
  minimumCacheableTokens,
  parseSmokeArgs,
  plannedCalls,
  redact,
  smokeMain,
  SMOKE_EXIT_SKIPPED_NO_KEY,
  worstCaseUsd,
} from "./smoke-anthropic.js";

// Only the pure parts: the script's live run is never exercised here.

const usage = (extra: Partial<NonNullable<CompletionResult["usage"]>> = {}) => ({
  promptTokens: 2600, completionTokens: 10, totalTokens: 2610, ...extra,
});
const result = (extra: Partial<CompletionResult>): CompletionResult => ({
  content: "", reasoningContent: "", stop: true, truncated: false,
  timing: {} as CompletionResult["timing"], cacheHitTokens: 0, slotId: 0, modelId: null, ...extra,
});

describe("parseSmokeArgs", () => {
  it("defaults to the cheap model and the built-in cap", () => {
    expect(parseSmokeArgs([])).toEqual({ model: "claude-haiku-5-5", help: false });
    expect(DEFAULT_MODEL).toBe("claude-haiku-5-5");
  });

  it("reads --model and --max-usd, and rejects bad values", () => {
    expect(parseSmokeArgs(["--model", "claude-fable-5-2", "--max-usd", "0.5"])).toEqual({
      model: "claude-fable-5-2", maxUsd: 0.5, help: false,
    });
    expect(() => parseSmokeArgs(["--max-usd", "0"])).toThrow(/positive/);
    expect(() => parseSmokeArgs(["--max-usd", "lots"])).toThrow(/positive/);
    expect(() => parseSmokeArgs(["--model"])).toThrow(/needs a value/);
    expect(() => parseSmokeArgs(["--model", "a b"])).toThrow(/not a model id/);
    expect(() => parseSmokeArgs(["--key", "x"])).toThrow(/unknown argument/);
  });
});

describe("cacheable prompt", () => {
  it("is fixed and long enough for the model's minimum", () => {
    expect(cacheableSystemPrompt("claude-haiku-5-5")).toBe(cacheableSystemPrompt("claude-haiku-5-5"));
    // About 2,000 tokens for the current models (4 chars a token over-counts English).
    expect(cacheableSystemPrompt("claude-haiku-5-5").length).toBeGreaterThanOrEqual(8000);
    expect(minimumCacheableTokens("claude-haiku-4-5-20251001")).toBe(4096);
    expect(cacheableSystemPrompt("claude-haiku-4-5").length).toBeGreaterThanOrEqual(4096 * 4);
  });
});

describe("budget", () => {
  const haiku = anthropicOfficialPricing({ kind: "anthropic" }, "claude-haiku-5-5")!;
  const fable = anthropicOfficialPricing({ kind: "anthropic" }, "claude-fable-5-2")!;

  it("bounds the default run far below the cap", () => {
    const worst = worstCaseUsd(plannedCalls("claude-haiku-5-5"), haiku);
    expect(worst).toBeGreaterThan(0);
    expect(worst).toBeLessThan(0.01);
    expect(checkBudget(worst, undefined)).toEqual({ ok: true, capUsd: 0.25 });
  });

  it("prices every planned call at its cap with cache writes, never reads", () => {
    const calls = [{ name: "x", inputTokens: 1_000_000, maxTokens: 1_000_000, cacheWrite: true }];
    expect(worstCaseUsd(calls, fable)).toBe(10 + 40);
    expect(worstCaseUsd([{ ...calls[0]!, cacheWrite: false }], fable)).toBe(8 + 40);
  });

  it("refuses above $0.25 unless --max-usd raises the cap, and still refuses above that", () => {
    const refused = checkBudget(0.3, undefined);
    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.message).toMatch(/\$0\.3000, above the \$0\.25 cap; pass --max-usd 0\.3/);
    expect(checkBudget(0.3, 0.5)).toEqual({ ok: true, capUsd: 0.5 });
    expect(checkBudget(0.6, 0.5).ok).toBe(false);
  });
});

describe("verdicts", () => {
  it("passes the cache check only when the second call reads from the cache", () => {
    expect(evaluateCache(usage({ cacheWriteTokens: 2500 }), usage({ cachedTokens: 2500 })).status).toBe("PASS");
    const miss = evaluateCache(usage({ cacheWriteTokens: 2500 }), usage({ cacheWriteTokens: 2500 }));
    expect(miss.status).toBe("FAIL");
    expect(miss.detail).toBe("first: cache_creation 2500, cache_read 0; second: cache_creation 2500, cache_read 0");
    expect(evaluateCache(undefined, usage()).status).toBe("FAIL");
  });

  it("passes the tool round trip when the tool is called and its result used", () => {
    const call = result({ toolCalls: [{ id: "t1", function: { name: TOOL_NAME, arguments: '{"country":"Freedonia"}' } }] });
    expect(evaluateToolCall(call, result({ content: "The capital is Ostrava-Prime." })).status).toBe("PASS");
    expect(evaluateToolCall(call, result({ content: "I am not sure." })).status).toBe("FAIL");
    expect(evaluateToolCall(call, undefined).status).toBe("FAIL");
    expect(evaluateToolCall(result({ content: "Paris" }), undefined).detail).toBe(`no ${TOOL_NAME} call (calls: none)`);
    const bad = result({ toolCalls: [{ function: { name: TOOL_NAME, arguments: "{" } }] });
    expect(evaluateToolCall(bad, result({ content: "Ostrava-Prime" })).status).toBe("FAIL");
  });

  it("reports effort output tokens as information", () => {
    expect(evaluateEffort(usage({ completionTokens: 40 }), usage({ completionTokens: 90 }))).toEqual({
      status: "INFO", detail: "output tokens: low 40, medium 90",
    });
    expect(evaluateEffort(usage({ completionTokens: 95 }), usage({ completionTokens: 90 })).detail).toContain("low spent more");
    expect(evaluateEffort(undefined, usage()).status).toBe("FAIL");
  });

  it("never prints the key", () => {
    expect(redact("401 for key sk-ant-abc123456 at api", "sk-ant-abc123456")).toBe("401 for key [redacted] at api");
  });
});

describe("smokeMain", () => {
  it("exits 3 (skipped: no key) without a key, so a wrapper cannot read it as a pass", async () => {
    const out: string[] = [];
    const code = await smokeMain([], {}, { stdout: (t) => out.push(t), stderr: () => undefined });
    expect(SMOKE_EXIT_SKIPPED_NO_KEY).toBe(3);
    expect(code).toBe(3);
    expect(out.join("")).toMatch(/skipped: ANTHROPIC_API_KEY is not set/);
  });

  it("--help still exits 0", async () => {
    expect(await smokeMain(["--help"], {}, { stdout: () => undefined, stderr: () => undefined })).toBe(0);
  });
});

describe("smokeMain reads the key the way the runtime does (env, then <stateDir>/.env)", () => {
  const REAL = "sk-ant-api03-real-looking-key-0123456789";
  const quiet = (sink: string[]) => ({ stdout: (t: string) => sink.push(t), stderr: (t: string) => sink.push(t) });

  it("uses the key saved in .env when the shell has none", async () => {
    const out: string[] = [];
    // An unpriced model stops the run right after the key check, before any request.
    const code = await smokeMain(["--model", "not-a-listed-model"], {}, quiet(out), { readStateDotenv: () => `ANTHROPIC_API_KEY=${REAL}\n` });
    expect(code).not.toBe(SMOKE_EXIT_SKIPPED_NO_KEY);
    expect(out.join("")).not.toContain(REAL);
  });

  it("does not send a placeholder left in the shell; it falls back to .env, else skips naming the placeholder", async () => {
    const out: string[] = [];
    const fallback = await smokeMain(["--model", "not-a-listed-model"], { ANTHROPIC_API_KEY: "..." }, quiet(out), { readStateDotenv: () => `ANTHROPIC_API_KEY=${REAL}\n` });
    expect(fallback).not.toBe(SMOKE_EXIT_SKIPPED_NO_KEY);
    expect(out.join("")).toContain("ANTHROPIC_API_KEY in the environment looks like a placeholder (3 characters); using the value from .env");
    const none: string[] = [];
    const skipped = await smokeMain([], { ANTHROPIC_API_KEY: "..." }, quiet(none), { readStateDotenv: () => null });
    expect(skipped).toBe(SMOKE_EXIT_SKIPPED_NO_KEY);
    expect(none.join("")).toContain("looks like a placeholder (3 characters)");
  });

  it("its how-to never suggests pasting a placeholder into the shell", async () => {
    const out: string[] = [];
    await smokeMain([], {}, quiet(out), { readStateDotenv: () => null });
    expect(out.join("")).not.toMatch(/="[^"]*\.\.\.[^"]*"/);
    expect(out.join("")).toContain(".env");
  });
});

