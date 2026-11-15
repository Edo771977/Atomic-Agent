/**
 * Live smoke test of the native Anthropic provider, run by hand with the
 * owner's own key. Not part of `npm test` or CI.
 *
 *   ANTHROPIC_API_KEY=... npm run smoke:anthropic
 *   npm run smoke:anthropic -- --model claude-fable-5-2 --max-usd 0.50
 *
 * Through the real `AnthropicProvider` (raw HTTP, the runtime's own wire
 * mapping), against https://api.anthropic.com:
 *  (a) prompt cache: the same request with a cacheable system prompt
 *      twice; PASS when the second reports cache-read tokens;
 *  (b) tool round trip: the model calls one simple tool, the result goes
 *      back, the model answers; PASS when both legs work;
 *  (c) effort: the same question at effort low and medium, output tokens
 *      reported (information, not a pass/fail);
 *  (d) the run's cost priced from the official price table.
 *
 * Spending: the worst case (every cacheable prefix written twice, every
 * reply at its token cap) is estimated before the first request; above
 * $0.25 the run refuses unless `--max-usd` raises the cap, and it stops
 * as soon as the priced spend passes the cap. A model missing from the
 * official table is refused (its cost cannot be bounded). The key is
 * never printed; offline mode (`ATOMIC_AGENT_OFFLINE`, `network.offline`)
 * refuses the run.
 */
import { fileURLToPath } from "node:url";

import { applyOfflineModeFromConfigFile } from "../src/cli/offline-from-config.js";
import { isOfflineNetwork } from "../src/llm/offline-network.js";
import { AnthropicProvider } from "../src/llm/provider/anthropic/anthropic-provider.js";
import type {
  CompletionRequest,
  CompletionResult,
  CompletionUsage,
  PromptMessages,
} from "../src/llm/provider/completion-types.js";
import { anthropicOfficialPricing } from "../src/llm/provider/official-prices/anthropic-official-prices.js";
import { estimateUsageCostUsd } from "../src/llm/provider/usage-cost.js";

type Pricing = NonNullable<ReturnType<typeof anthropicOfficialPricing>>;

export const DEFAULT_MODEL = "claude-haiku-5-5";
export const DEFAULT_MAX_USD = 0.25;

// ------------------------------------------------------------ arguments

export type SmokeArgs = { model: string; maxUsd?: number; help: boolean };

export function parseSmokeArgs(argv: readonly string[]): SmokeArgs {
  const args: SmokeArgs = { model: DEFAULT_MODEL, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--model") {
      const model = value().trim();
      if (!/^[a-z0-9][a-z0-9.-]*$/i.test(model)) throw new Error(`--model: not a model id: ${model}`);
      args.model = model;
    } else if (a === "--max-usd") {
      const raw = value();
      const usd = Number(raw);
      if (!Number.isFinite(usd) || usd <= 0) throw new Error(`--max-usd: not a positive amount: ${raw}`);
      args.maxUsd = usd;
    } else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

// ----------------------------------------------------------------- plan

/**
 * The smallest prompt the model caches (Anthropic's prompt-caching docs);
 * shorter prefixes silently do not cache. Unlisted models get 512, the
 * current generation's value.
 */
export function minimumCacheableTokens(model: string): number {
  const id = model.toLowerCase().replace(/-\d{8}$/, "");
  if (["claude-haiku-4-5", "claude-opus-4-5", "claude-opus-4-6"].includes(id)) return 4096;
  if (id === "claude-opus-4-7") return 2048;
  if (["claude-opus-4-8", "claude-sonnet-5", "claude-sonnet-4-6", "claude-sonnet-4-5"].includes(id)) return 1024;
  return 512;
}

/** Words the filler is made of: fixed, so every run sends the same bytes. */
const FILLER_SENTENCE =
  "Reference note: the archive keeps every ledger entry in the order it was written, and each entry names its date, its author and the account it moves.";

/**
 * A fixed system prompt of at least `tokens` tokens (about 2,000 for the
 * current models, more for an older model with a higher minimum),
 * counting a token as four characters, which over-counts English text.
 */
export function cacheableSystemPrompt(model: string): string {
  const tokens = Math.max(2000, Math.ceil(minimumCacheableTokens(model) * 1.25));
  const lines = ["You are the smoke test of a local agent runtime. Follow the user's instruction exactly."];
  for (let i = 1; lines.join("\n").length < tokens * 4; i++) lines.push(`${i}. ${FILLER_SENTENCE}`);
  return lines.join("\n");
}

const estimateTokens = (text: string) => Math.ceil(text.length / 3);

export type PlannedCall = { name: string; inputTokens: number; maxTokens: number; cacheWrite?: boolean };

export const REPLY_TOKENS = 512;
export const EFFORT_TOKENS = 2048;
/** Tool definitions plus Anthropic's tool-use system prompt, generously. */
const TOOL_OVERHEAD_TOKENS = 1000;

export function plannedCalls(model: string): PlannedCall[] {
  const cached = estimateTokens(cacheableSystemPrompt(model)) + TOOL_OVERHEAD_TOKENS;
  return [
    { name: "cache write", inputTokens: cached, maxTokens: REPLY_TOKENS, cacheWrite: true },
    { name: "cache read", inputTokens: cached, maxTokens: REPLY_TOKENS, cacheWrite: true },
    { name: "tool call", inputTokens: TOOL_OVERHEAD_TOKENS, maxTokens: REPLY_TOKENS },
    { name: "tool result", inputTokens: TOOL_OVERHEAD_TOKENS + 200, maxTokens: REPLY_TOKENS },
    { name: "effort low", inputTokens: 200, maxTokens: EFFORT_TOKENS },
    { name: "effort medium", inputTokens: 200, maxTokens: EFFORT_TOKENS },
  ];
}

/** Every call at its cap, every cacheable prefix written (never read): the most the run can cost. */
export function worstCaseUsd(calls: readonly PlannedCall[], pricing: Pricing): number {
  return calls.reduce((sum, call) => {
    const inputRate = call.cacheWrite ? (pricing.cacheWrite ?? pricing.input) : pricing.input;
    return sum + (call.inputTokens * inputRate + call.maxTokens * pricing.output) / 1_000_000;
  }, 0);
}

export type BudgetCheck = { ok: true; capUsd: number } | { ok: false; capUsd: number; message: string };

export function checkBudget(worstUsd: number, maxUsd: number | undefined): BudgetCheck {
  const capUsd = maxUsd ?? DEFAULT_MAX_USD;
  if (worstUsd <= capUsd) return { ok: true, capUsd };
  const advice = maxUsd === undefined
    ? `pass --max-usd ${Math.ceil(worstUsd * 100) / 100} (or more) to run anyway`
    : "raise --max-usd or pick a cheaper --model";
  return {
    ok: false,
    capUsd,
    message: `refusing to start: the worst case is $${worstUsd.toFixed(4)}, above the $${capUsd.toFixed(2)} cap; ${advice}`,
  };
}

// ------------------------------------------------------------- verdicts

export type Verdict = { status: "PASS" | "FAIL" | "INFO"; detail: string };

export function evaluateCache(first: CompletionUsage | undefined, second: CompletionUsage | undefined): Verdict {
  if (first === undefined || second === undefined) return { status: "FAIL", detail: "a reply carried no usage" };
  const detail =
    `first: cache_creation ${first.cacheWriteTokens ?? 0}, cache_read ${first.cachedTokens ?? 0}; ` +
    `second: cache_creation ${second.cacheWriteTokens ?? 0}, cache_read ${second.cachedTokens ?? 0}`;
  return { status: (second.cachedTokens ?? 0) > 0 ? "PASS" : "FAIL", detail };
}

export const TOOL_NAME = "lookup_capital";

export function evaluateToolCall(call: CompletionResult, answer: CompletionResult | undefined): Verdict {
  const tool = call.toolCalls?.find((c) => c.function.name === TOOL_NAME);
  if (tool === undefined) {
    const names = (call.toolCalls ?? []).map((c) => c.function.name);
    return { status: "FAIL", detail: `no ${TOOL_NAME} call (calls: ${names.join(", ") || "none"})` };
  }
  let args: unknown;
  try {
    args = JSON.parse(tool.function.arguments);
  } catch {
    return { status: "FAIL", detail: `unparseable arguments ${tool.function.arguments}` };
  }
  if (answer === undefined) return { status: "FAIL", detail: "no answer after the tool result" };
  const text = answer.content.trim();
  if (text === "") return { status: "FAIL", detail: "empty answer after the tool result" };
  const usedResult = /Ostrava-Prime/i.test(text);
  return {
    status: usedResult ? "PASS" : "FAIL",
    detail: `called with ${JSON.stringify(args)}; answer ${usedResult ? "uses" : "ignores"} the tool result: ${JSON.stringify(text.slice(0, 120))}`,
  };
}

export function evaluateEffort(low: CompletionUsage | undefined, medium: CompletionUsage | undefined): Verdict {
  if (low === undefined || medium === undefined) return { status: "FAIL", detail: "a reply carried no usage" };
  const note = low.completionTokens <= medium.completionTokens ? "" : " (low spent more: effort is a hint, not a cap)";
  return { status: "INFO", detail: `output tokens: low ${low.completionTokens}, medium ${medium.completionTokens}${note}` };
}

/** `text` with every occurrence of the key replaced, for anything printed. */
export function redact(text: string, key: string): string {
  return key.length < 8 ? text : text.split(key).join("[redacted]");
}

// ------------------------------------------------------------------ run

const TOOLS = [
  {
    type: "function",
    function: {
      name: TOOL_NAME,
      description: "Look up the capital city of a country in the test atlas.",
      parameters: {
        type: "object",
        properties: { country: { type: "string", description: "The country name" } },
        required: ["country"],
        additionalProperties: false,
      },
    },
  },
];

const prompt = (system: string, turns: PromptMessages["turns"], tail: string): Pick<CompletionRequest, "prompt" | "messages" | "tools"> => ({
  prompt: `${system}\n\n${tail}`,
  messages: { system, droppedSummary: null, turns, tail },
  tools: TOOLS,
});

class BudgetExceeded extends Error {}

async function run(args: SmokeArgs, apiKey: string, pricing: Pricing, capUsd: number): Promise<number> {
  const provider = new AnthropicProvider({ id: "anthropic-smoke", apiKey, defaultChatModel: args.model });
  let spent = 0;
  const failures: string[] = [];
  const send = async (name: string, request: Omit<CompletionRequest, "prompt"> & { prompt: string }) => {
    const result = await provider.complete({ ...request, reasoningEffort: request.reasoningEffort ?? "low" });
    const usd = result.usage === undefined ? 0 : estimateUsageCostUsd(result.usage, pricing);
    spent += usd;
    process.stdout.write(`  ${name}: in ${result.usage?.promptTokens ?? "?"}, out ${result.usage?.completionTokens ?? "?"}, $${usd.toFixed(5)}\n`);
    if (spent > capUsd) throw new BudgetExceeded(`spent $${spent.toFixed(4)}, past the $${capUsd.toFixed(2)} cap: stopping`);
    return result;
  };
  const report = (label: string, v: Verdict) => {
    process.stdout.write(`${v.status} ${label}: ${v.detail}\n`);
    if (v.status === "FAIL") failures.push(label);
  };
  try {
    process.stdout.write("(a) prompt cache\n");
    const system = cacheableSystemPrompt(args.model);
    const cacheRequest = { ...prompt(system, [], "Reply with the single word OK. Do not call any tool."), maxTokens: REPLY_TOKENS };
    const first = await send("first", cacheRequest);
    const second = await send("second", cacheRequest);
    report("prompt cache", evaluateCache(first.usage, second.usage));

    process.stdout.write("(b) tool round trip\n");
    const toolSystem = "You answer geography questions from the test atlas. Always use the lookup_capital tool; never answer from memory.";
    const question = "What is the capital of Freedonia according to the test atlas?";
    const call = await send("call", { ...prompt(toolSystem, [{ kind: "user", text: question }], ""), maxTokens: REPLY_TOKENS });
    const tool = call.toolCalls?.find((c) => c.function.name === TOOL_NAME);
    let answer: CompletionResult | undefined;
    if (tool !== undefined) {
      let callArgs: Record<string, unknown> = {};
      try {
        callArgs = JSON.parse(tool.function.arguments) as Record<string, unknown>;
      } catch {
        // evaluateToolCall reports it.
      }
      answer = await send("answer", {
        ...prompt(toolSystem, [
          { kind: "user", text: question },
          { kind: "assistant_tool_call", tool: TOOL_NAME, args: callArgs, ...(tool.id ? { callId: tool.id } : {}) },
          { kind: "tool_result", tool: TOOL_NAME, status: "ok", body: "Ostrava-Prime", truncated: false, ...(tool.id ? { callId: tool.id } : {}) },
        ], "Answer the question in one sentence using the tool result."),
        maxTokens: REPLY_TOKENS,
      });
    }
    report("tool round trip", evaluateToolCall(call, answer));

    process.stdout.write("(c) effort low vs medium\n");
    const effortPrompt = "In about three sentences, explain why the sky looks blue.";
    const effortRequest = { prompt: effortPrompt, maxTokens: EFFORT_TOKENS };
    const low = await send("low", { ...effortRequest, reasoningEffort: "low" });
    const medium = await send("medium", { ...effortRequest, reasoningEffort: "medium" });
    report("effort", evaluateEffort(low.usage, medium.usage));
  } catch (err) {
    if (err instanceof BudgetExceeded) {
      process.stdout.write(`FAIL budget: ${err.message}\n`);
    } else {
      process.stdout.write(`FAIL request: ${redact(err instanceof Error ? err.message : String(err), apiKey)}\n`);
    }
    failures.push("run");
  }
  process.stdout.write(`(d) cost of this run: $${spent.toFixed(5)} at Anthropic's official prices for ${args.model}\n`);
  process.stdout.write(failures.length === 0 ? "smoke:anthropic passed\n" : `smoke:anthropic FAILED: ${failures.join(", ")}\n`);
  return failures.length === 0 ? 0 : 1;
}

const HOW_TO_SET_KEY = [
  "ANTHROPIC_API_KEY is not set; nothing was sent.",
  "Set it for this one command, then run again:",
  '  macOS/Linux:        ANTHROPIC_API_KEY="sk-ant-..." npm run smoke:anthropic',
  '  Windows PowerShell: $env:ANTHROPIC_API_KEY="sk-ant-..."; npm run smoke:anthropic',
  "Options: --model <id> (default claude-haiku-5-5), --max-usd <amount> (default cap $0.25).",
].join("\n");

async function main(): Promise<number> {
  let args: SmokeArgs;
  try {
    args = parseSmokeArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\nusage: npm run smoke:anthropic [-- --model <id>] [-- --max-usd <amount>]\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(`${HOW_TO_SET_KEY.split("\n").slice(1).join("\n")}\n`);
    return 0;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim() ?? "";
  if (apiKey === "") {
    process.stdout.write(`${HOW_TO_SET_KEY}\n`);
    return 0;
  }
  applyOfflineModeFromConfigFile();
  if (isOfflineNetwork()) {
    process.stderr.write("offline mode is on (ATOMIC_AGENT_OFFLINE or network.offline): the smoke test needs api.anthropic.com. Nothing was sent.\n");
    return 2;
  }
  const pricing = anthropicOfficialPricing({ kind: "anthropic" }, args.model);
  if (pricing === undefined) {
    process.stderr.write(`${args.model} is not in the official price table, so the run's cost cannot be bounded; pick a listed model.\n`);
    return 2;
  }
  const worst = worstCaseUsd(plannedCalls(args.model), pricing);
  const budget = checkBudget(worst, args.maxUsd);
  if (!budget.ok) {
    process.stderr.write(`${budget.message}\n`);
    return 2;
  }
  process.stdout.write(`smoke:anthropic on ${args.model}: worst case $${worst.toFixed(4)}, cap $${budget.capUsd.toFixed(2)}\n`);
  return run(args, apiKey, pricing, budget.capUsd);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main();
}
