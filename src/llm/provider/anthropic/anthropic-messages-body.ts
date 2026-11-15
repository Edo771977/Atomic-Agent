/**
 * The OpenAI chat body the shared builder produced, as an Anthropic
 * Messages API body (`POST /v1/messages`).
 *
 * The native kind reuses `buildOpenAiChatBody` for everything that is
 * not the wire spelling (the native message layout, tool-name escapes,
 * strict tools, effort defaults, cache breakpoints, `extraBody` and
 * model `params`) and translates its result here, as the last step
 * before the physical send, so `requestBudget.beforeSend` sees the body
 * that actually goes out.
 *
 * Mapping rules (each one exists because the API rejects the request
 * otherwise, or because the stable prefix must stay byte-stable):
 *  - `system` messages become the top-level `system` text blocks. The
 *    stable prefix is the first one, so a breakpoint on its block caches
 *    tools + system (tools render before system).
 *  - assistant `tool_calls` become `tool_use` blocks; every `tool`
 *    message of one step becomes a `tool_result` block in ONE user
 *    message (consecutive same-role messages are merged, tool results
 *    first). A result our own renderer marked `error: …` is `is_error`.
 *  - `reasoning_content` on history messages is dropped: thinking blocks
 *    are never replayed, because the packer and compaction edit history
 *    and a replayed block bound to an edited prefix is a 400.
 *  - `tool_choice` is only ever `auto` or `none`: Fable 5.x, Opus 5.5
 *    and Sonnet 5.5 answer a forced `any` / `tool` with a 400.
 *  - `max_tokens` is required: the body's own cap, else the default.
 *  - sampling parameters (`temperature`, `top_p`, `top_k`) are sent only
 *    when the entry configured them explicitly (`extraBody` / `params`)
 *    AND the pinned `anthropic-version` predates 2026-10-21, which
 *    rejects them on every model.
 *  - other explicit keys pass through only when they are Messages API
 *    fields ({@link PASSTHROUGH_KEYS}). Compat-era OpenAI keys are
 *    translated where they mean something here (`max_completion_tokens`,
 *    `reasoning_effort`, `parallel_tool_calls`) and otherwise dropped, so
 *    an old OpenAI-compatible entry routed to this client does not fail
 *    every request with "Extra inputs are not permitted".
 */

import { TOOL_ERROR_PREFIX } from "../openai/openai-native-messages.js";
import {
  ANTHROPIC_EFFORT_LEVELS,
  anthropicEffortLevels,
  clampAnthropicEffort,
  type AnthropicEffort,
} from "../openai/model-params.js";

/**
 * `max_tokens` when nothing bounded the reply: the API requires the
 * field. A reply budget, not the context window (a window-sized cap is a
 * 400 and would hold a window of dollars in the request budget).
 */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 32_000;

/** Keys the translation owns; an explicit passthrough cannot replace them. */
const OWNED_KEYS = new Set([
  "model",
  "messages",
  "system",
  "stream",
  "tools",
  "tool_choice",
  "max_tokens",
]);

/**
 * OpenAI-only keys the builder may write that the Messages API does not
 * define. Dropped unless the operator set them explicitly, in which case
 * they pass through as written (their responsibility).
 */
const SAMPLING_KEYS = new Set(["temperature", "top_p", "top_k"]);

/** The first `anthropic-version` that answers any sampling parameter with a 400. */
export const NO_SAMPLING_API_VERSION = "2026-10-21";

/**
 * Explicit keys copied as written: Messages API request fields this
 * translation does not build itself. Anything else an entry sets is
 * dropped (with a warning), since the API answers an unknown top-level
 * field with a 400. Extend this list when the API adds a field.
 */
export const PASSTHROUGH_KEYS: ReadonlySet<string> = new Set([
  "metadata",
  "stop_sequences",
  "service_tier",
  "thinking",
  "inference_geo",
  "speed",
  "cache_control",
  "container",
  "mcp_servers",
  "context_management",
]);

/** Explicit keys translated into a Messages field (never copied as written). */
const TRANSLATED_KEYS = new Set([
  "output_config",
  "stop",
  "response_format",
  "max_completion_tokens",
  "reasoning_effort",
  "parallel_tool_calls",
]);

export interface AnthropicBodyOptions {
  /**
   * Keys the entry's `extraBody` / model `params` set. Only these are
   * copied through verbatim, and only these bring sampling parameters.
   */
  explicitKeys?: ReadonlySet<string>;
  /** The `anthropic-version` the request is sent with; sampling keys are dropped from 2026-10-21. */
  apiVersion?: string;
  /** Told the explicit keys this body left out (the provider warns once). */
  onDroppedKeys?: (keys: readonly string[]) => void;
}

/** Does this `anthropic-version` still take sampling parameters? Unparsable versions are treated as current. */
export function apiVersionTakesSampling(version: string | undefined): boolean {
  if (version === undefined) return false;
  const trimmed = version.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return false;
  return trimmed < NO_SAMPLING_API_VERSION;
}

type Block = Record<string, unknown>;
type Message = { role: "user" | "assistant"; content: Block[] };

export function toAnthropicMessagesBody(
  openAi: Record<string, unknown>,
  options: AnthropicBodyOptions = {},
): Record<string, unknown> {
  const explicit = options.explicitKeys ?? new Set<string>();
  const { system, messages } = translateMessages(
    Array.isArray(openAi.messages) ? (openAi.messages as Block[]) : [],
  );
  const body: Record<string, unknown> = {
    model: openAi.model,
    max_tokens: readCap(openAi),
    ...(system.length > 0 ? { system } : {}),
    messages,
  };
  const tools = translateTools(openAi.tools);
  if (tools.length > 0) {
    body.tools = tools;
    const choice = translateToolChoice(openAi.tool_choice, openAi.parallel_tool_calls);
    if (choice !== undefined) body.tool_choice = choice;
  }
  if (Array.isArray(openAi.stop) && openAi.stop.length > 0) {
    body.stop_sequences = openAi.stop;
  } else if (typeof openAi.stop === "string" && openAi.stop.length > 0) {
    body.stop_sequences = [openAi.stop];
  }
  const dropped: string[] = [];
  const outputConfig = translateOutputConfig(openAi);
  const effort = explicit.has("reasoning_effort")
    ? translateReasoningEffort(openAi.reasoning_effort, openAi.model, explicit, outputConfig)
    : undefined;
  if (effort === null) dropped.push("reasoning_effort");
  const config = effort ? { ...outputConfig, effort } : outputConfig;
  if (config !== undefined) body.output_config = config;
  const sampling = apiVersionTakesSampling(options.apiVersion);
  for (const key of SAMPLING_KEYS) {
    if (!explicit.has(key) || openAi[key] === undefined) continue;
    if (sampling) body[key] = openAi[key];
    else dropped.push(key);
  }
  // The operator's own passthrough fields (`thinking`, `metadata`,
  // `service_tier`, …), as written. Owned keys and the ones translated
  // above keep the translation's value; anything the API does not define
  // is left out.
  for (const key of explicit) {
    if (OWNED_KEYS.has(key) || SAMPLING_KEYS.has(key) || TRANSLATED_KEYS.has(key)) continue;
    if (openAi[key] === undefined) continue;
    if (PASSTHROUGH_KEYS.has(key)) body[key] = openAi[key];
    else dropped.push(key);
  }
  if (openAi.stream === true) body.stream = true;
  if (dropped.length > 0) options.onDroppedKeys?.(dropped);
  return body;
}

/**
 * An explicit OpenAI-style `reasoning_effort` as `output_config.effort`,
 * clamped to the model's levels. `undefined` when the entry's own
 * `output_config.effort` already says it; `null` when the value or the
 * model takes no effort (dropped).
 */
function translateReasoningEffort(
  raw: unknown,
  model: unknown,
  explicit: ReadonlySet<string>,
  outputConfig: Record<string, unknown> | undefined,
): AnthropicEffort | undefined | null {
  if (explicit.has("output_config") && outputConfig?.effort !== undefined) return undefined;
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  const requested: AnthropicEffort | undefined =
    value === "minimal" ? "low" : (ANTHROPIC_EFFORT_LEVELS as readonly string[]).includes(value) ? (value as AnthropicEffort) : undefined;
  if (requested === undefined) return null;
  const levels = typeof model === "string" ? anthropicEffortLevels(model) : null;
  return levels === null ? null : clampAnthropicEffort(requested, levels);
}

function readCap(openAi: Record<string, unknown>): number {
  for (const key of ["max_tokens", "max_completion_tokens"] as const) {
    const value = openAi[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }
  }
  return ANTHROPIC_DEFAULT_MAX_TOKENS;
}

/**
 * `output_config`: the effort the builder spelled for this kind
 * (`reasoningEffortField`), plus Structured Outputs when the sub-call
 * asked for a JSON schema (`response_format` → `output_config.format`).
 */
function translateOutputConfig(
  openAi: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const base = isRecord(openAi.output_config) ? { ...openAi.output_config } : {};
  const format = openAi.response_format;
  if (isRecord(format) && format.type === "json_schema" && isRecord(format.json_schema)) {
    const schema = format.json_schema.schema;
    if (isRecord(schema)) base.format = { type: "json_schema", schema };
  }
  return Object.keys(base).length > 0 ? base : undefined;
}

function translateTools(raw: unknown): Block[] {
  if (!Array.isArray(raw)) return [];
  const out: Block[] = [];
  for (const tool of raw) {
    if (!isRecord(tool)) continue;
    const fn = isRecord(tool.function) ? tool.function : tool;
    if (typeof fn.name !== "string" || fn.name.length === 0) continue;
    const parameters = isRecord(fn.parameters)
      ? fn.parameters
      : isRecord(fn.input_schema)
        ? fn.input_schema
        : { type: "object", properties: {} };
    out.push({
      name: fn.name,
      ...(typeof fn.description === "string" && fn.description.length > 0
        ? { description: fn.description }
        : {}),
      input_schema: parameters.type === undefined ? { type: "object", ...parameters } : parameters,
      ...(fn.strict === true ? { strict: true } : {}),
    });
  }
  return out;
}

/**
 * Only `auto` or `none`. A forced call (`required`, a named function) is
 * sent as `auto`: the models this kind targets answer `any` / `tool`
 * with a 400, and the prompt already says which tool to call.
 */
function translateToolChoice(
  choice: unknown,
  parallel: unknown,
): Record<string, unknown> | undefined {
  if (choice === "none") return { type: "none" };
  const noParallel = parallel === false;
  if (choice === undefined && !noParallel) return undefined;
  return { type: "auto", ...(noParallel ? { disable_parallel_tool_use: true } : {}) };
}

function translateMessages(input: readonly Block[]): {
  system: Block[];
  messages: Message[];
} {
  const system: Block[] = [];
  const messages: Message[] = [];
  const push = (role: Message["role"], blocks: Block[]): void => {
    if (blocks.length === 0) return;
    const last = messages[messages.length - 1];
    if (last && last.role === role) {
      // Tool results must open the user message that answers the calls.
      if (role === "user" && blocks.some((b) => b.type === "tool_result")) {
        const results = blocks.filter((b) => b.type === "tool_result");
        const others = blocks.filter((b) => b.type !== "tool_result");
        const lastResults = last.content.filter((b) => b.type === "tool_result");
        const lastOthers = last.content.filter((b) => b.type !== "tool_result");
        last.content = [...lastResults, ...results, ...lastOthers, ...others];
        return;
      }
      last.content.push(...blocks);
      return;
    }
    messages.push({ role, content: blocks });
  };
  for (const message of input) {
    const role = message.role;
    if (role === "system" || role === "developer") {
      system.push(...textBlocks(message.content));
      continue;
    }
    if (role === "tool") {
      push("user", [toolResultBlock(message)]);
      continue;
    }
    if (role === "assistant") {
      const blocks = textBlocks(message.content);
      if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          const block = toolUseBlock(call);
          if (block) blocks.push(block);
        }
      }
      push("assistant", blocks);
      continue;
    }
    push("user", contentBlocks(message.content));
  }
  // The first message must be the user's, and the last must not be an
  // assistant turn (an assistant prefill is a 400 on the 4.6+ models).
  if (messages.length === 0 || messages[0]!.role !== "user") {
    messages.unshift({ role: "user", content: [{ type: "text", text: "(conversation continues)" }] });
  }
  if (messages[messages.length - 1]!.role === "assistant") {
    messages.push({ role: "user", content: [{ type: "text", text: "Continue." }] });
  }
  return { system, messages };
}

/** Text parts of a string or parts array; empty text is never sent (a 400). */
function textBlocks(content: unknown): Block[] {
  return contentBlocks(content).filter((b) => b.type === "text");
}

function contentBlocks(content: unknown): Block[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const out: Block[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    const cache = isRecord(part.cache_control) ? { cache_control: part.cache_control } : {};
    if (part.type === "text" && typeof part.text === "string") {
      if (part.text.length > 0) out.push({ type: "text", text: part.text, ...cache });
      continue;
    }
    if (part.type === "image_url") {
      const url = isRecord(part.image_url) ? part.image_url.url : part.image_url;
      const image = typeof url === "string" ? imageBlock(url) : null;
      if (image) out.push({ ...image, ...cache });
      continue;
    }
    if (part.type === "image") out.push(part);
  }
  return out;
}

function imageBlock(url: string): Block | null {
  const data = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (data) {
    return { type: "image", source: { type: "base64", media_type: data[1], data: data[2] } };
  }
  if (/^https?:\/\//i.test(url)) return { type: "image", source: { type: "url", url } };
  return null;
}

function toolUseBlock(call: unknown): Block | null {
  if (!isRecord(call) || !isRecord(call.function)) return null;
  const name = call.function.name;
  if (typeof name !== "string" || name.length === 0) return null;
  return {
    type: "tool_use",
    id: wireId(call.id),
    name,
    input: parseArguments(call.function.arguments),
  };
}

function toolResultBlock(message: Block): Block {
  const parts = contentBlocks(message.content);
  const text = parts
    .filter((b) => b.type === "text")
    .map((b) => b.text as string)
    .join("\n");
  const cache = parts.find((b) => isRecord(b.cache_control))?.cache_control;
  return {
    type: "tool_result",
    tool_use_id: wireId(message.tool_call_id),
    content: text.length > 0 ? text : "(empty)",
    ...(text.startsWith(TOOL_ERROR_PREFIX) ? { is_error: true } : {}),
    ...(cache !== undefined ? { cache_control: cache } : {}),
  };
}

/** Tool ids must match `^[a-zA-Z0-9_-]+$`; the same rewrite on both sides keeps pairs matched. */
function wireId(raw: unknown): string {
  const id = typeof raw === "string" && raw.length > 0 ? raw : "call";
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function parseArguments(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw;
  if (typeof raw !== "string" || raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : { value: parsed };
  } catch {
    return { arguments: raw };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
