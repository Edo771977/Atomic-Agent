/**
 * An Anthropic Messages response, unary or streamed, in the OpenAI chat
 * shape the shared pipeline already reads (`normaliseOpenAiChatResponse`,
 * `createOpenAiStreamConsumer`). One translation for both paths, so the
 * usage, the finish reason and the tool calls cannot disagree between
 * them.
 *
 * Usage: Anthropic's `input_tokens` excludes the cache, so the prompt is
 * `input + cache_read + cache_creation`; the cache counts ride as
 * `prompt_tokens_details.cached_tokens` / `cache_write_tokens`, which is
 * where `CompletionUsage.cachedTokens`, `cacheWriteTokens` and
 * `cacheHitTokens` are read from.
 *
 * Stop reasons: `end_turn` / `stop_sequence` → `stop`, `tool_use` →
 * `tool_calls`, `max_tokens` → `length` (truncated, as everywhere),
 * `refusal` → a typed failure (`anthropicRefusalMessage`), never content.
 * `pause_turn` cannot happen (no server tools are sent).
 */

import { createSseLineNormaliser } from "../../sse-line-endings.js";

/** The status a refusal is typed with: a moderation-style 403, never the key's. */
export const ANTHROPIC_REFUSAL_STATUS = 403;

export function anthropicFinishReason(stopReason: unknown): string | null {
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
      return "stop";
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "refusal":
      return "refusal";
    default:
      return typeof stopReason === "string" ? stopReason : null;
  }
}

/**
 * The sentence a refusal carries. Worded so the moderation classifiers
 * read it as a content refusal ("request was flagged"), not a dead key.
 */
export function anthropicRefusalMessage(stopDetails: unknown): string {
  const details = isRecord(stopDetails) ? stopDetails : {};
  const category =
    typeof details.category === "string" && details.category.length > 0
      ? `, category ${details.category}`
      : "";
  const explanation =
    typeof details.explanation === "string" && details.explanation.length > 0
      ? ` ${details.explanation}`
      : "";
  return `Claude declined to answer: the request was flagged by Anthropic's safety classifiers (stop_reason refusal${category}).${explanation}`;
}

/** Anthropic usage as an OpenAI `usage` block with cache details. */
export function anthropicUsageToOpenAi(
  usage: Record<string, unknown>,
): Record<string, unknown> {
  const input = count(usage.input_tokens);
  const read = count(usage.cache_read_input_tokens);
  const write = count(usage.cache_creation_input_tokens);
  const output = count(usage.output_tokens);
  const prompt = input + read + write;
  return {
    prompt_tokens: prompt,
    completion_tokens: output,
    total_tokens: prompt + output,
    prompt_tokens_details: { cached_tokens: read, cache_write_tokens: write },
  };
}

/** Error `type` → the HTTP status the rest of the runtime classifies on. */
export function anthropicErrorStatus(type: unknown): number | null {
  switch (type) {
    case "invalid_request_error":
      return 400;
    case "authentication_error":
      return 401;
    case "billing_error":
      return 402;
    case "permission_error":
      return 403;
    case "not_found_error":
      return 404;
    case "request_too_large":
      return 413;
    case "rate_limit_error":
      return 429;
    case "api_error":
      return 500;
    case "timeout_error":
      return 504;
    case "overloaded_error":
      return 529;
    default:
      return null;
  }
}

export class AnthropicRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnthropicRefusal";
  }
}

/**
 * A unary Messages response as an OpenAI chat completion. Throws
 * `AnthropicRefusal` for `stop_reason: "refusal"`: the caller turns it
 * into the typed HTTP failure.
 */
export function anthropicMessageToOpenAi(
  json: Record<string, unknown>,
): Record<string, unknown> {
  if (json.stop_reason === "refusal") {
    throw new AnthropicRefusal(anthropicRefusalMessage(json.stop_details));
  }
  const blocks = Array.isArray(json.content) ? json.content : [];
  let text = "";
  let reasoning = "";
  const toolCalls: Record<string, unknown>[] = [];
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") text += block.text;
    else if (block.type === "thinking" && typeof block.thinking === "string") reasoning += block.thinking;
    else if (block.type === "tool_use" && typeof block.name === "string") {
      toolCalls.push({
        id: typeof block.id === "string" ? block.id : `call_${toolCalls.length}`,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }
  return {
    ...(typeof json.id === "string" ? { id: json.id } : {}),
    ...(typeof json.model === "string" ? { model: json.model } : {}),
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text,
          ...(reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: anthropicFinishReason(json.stop_reason),
      },
    ],
    ...(isRecord(json.usage) ? { usage: anthropicUsageToOpenAi(json.usage) } : {}),
  };
}

/**
 * Rewrites an Anthropic SSE byte stream into OpenAI chat-completion SSE
 * (`data: {chunk}` events and a final `data: [DONE]`).
 *
 * Events: `message_start` (id, model, input and cache usage),
 * `content_block_start` (a `tool_use` opens a call at its own index),
 * `content_block_delta` (`text_delta` → content, `thinking_delta` →
 * `reasoning_content`, `input_json_delta` → the call's arguments;
 * `signature_delta` is dropped), `message_delta` (stop reason and output
 * usage → `finish_reason` + `usage`), `message_stop` → `[DONE]`, `error`
 * → an OpenAI error object with the mapped status, `ping` ignored. A
 * refusal becomes an error event (moderation 403), so no tool call of a
 * refused reply is ever dispatched.
 */
export function createAnthropicSseTranslator(): {
  push(text: string): string;
  flush(): string;
} {
  const lineEndings = createSseLineNormaliser();
  let buffer = "";
  let id: string | undefined;
  let model: string | undefined;
  let usage: Record<string, unknown> = {};
  /** Anthropic content-block index → OpenAI tool-call index. */
  const toolIndex = new Map<number, number>();
  let finished = false;

  const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
    `data: ${JSON.stringify({
      ...(id !== undefined ? { id } : {}),
      ...(model !== undefined ? { model } : {}),
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta, finish_reason: null, ...extra }],
    })}\n\n`;

  const handle = (event: Record<string, unknown>): string => {
    switch (event.type) {
      case "message_start": {
        const message = isRecord(event.message) ? event.message : {};
        if (typeof message.id === "string") id = message.id;
        if (typeof message.model === "string") model = message.model;
        if (isRecord(message.usage)) usage = { ...usage, ...message.usage };
        return chunk({ role: "assistant" });
      }
      case "content_block_start": {
        const block = isRecord(event.content_block) ? event.content_block : {};
        const index = typeof event.index === "number" ? event.index : -1;
        if (block.type === "tool_use") {
          const position = toolIndex.size;
          toolIndex.set(index, position);
          return chunk({
            tool_calls: [
              {
                index: position,
                id: typeof block.id === "string" ? block.id : `call_${position}`,
                type: "function",
                function: { name: typeof block.name === "string" ? block.name : "", arguments: "" },
              },
            ],
          });
        }
        if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
          return chunk({ content: block.text });
        }
        return "";
      }
      case "content_block_delta": {
        const delta = isRecord(event.delta) ? event.delta : {};
        const index = typeof event.index === "number" ? event.index : -1;
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          return delta.text.length > 0 ? chunk({ content: delta.text }) : "";
        }
        if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          return delta.thinking.length > 0 ? chunk({ reasoning_content: delta.thinking }) : "";
        }
        if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const position = toolIndex.get(index);
          if (position === undefined || delta.partial_json.length === 0) return "";
          return chunk({ tool_calls: [{ index: position, function: { arguments: delta.partial_json } }] });
        }
        return "";
      }
      case "message_delta": {
        const delta = isRecord(event.delta) ? event.delta : {};
        if (isRecord(event.usage)) usage = { ...usage, ...event.usage };
        if (delta.stop_reason === "refusal") {
          finished = true;
          return errorEvent(ANTHROPIC_REFUSAL_STATUS, anthropicRefusalMessage(delta.stop_details));
        }
        const finish = anthropicFinishReason(delta.stop_reason);
        return `data: ${JSON.stringify({
          ...(id !== undefined ? { id } : {}),
          ...(model !== undefined ? { model } : {}),
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: finish }],
          usage: anthropicUsageToOpenAi(usage),
        })}\n\n`;
      }
      case "message_stop":
        if (finished) return "";
        finished = true;
        return "data: [DONE]\n\n";
      case "error": {
        const error = isRecord(event.error) ? event.error : {};
        finished = true;
        return errorEvent(
          anthropicErrorStatus(error.type),
          typeof error.message === "string" && error.message.length > 0
            ? `${String(error.type ?? "error")}: ${error.message}`
            : String(error.type ?? "stream error"),
        );
      }
      default:
        return "";
    }
  };

  const drain = (final: boolean): string => {
    let out = "";
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end < 0) break;
      out += translateEvent(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
    }
    if (final && buffer.trim().length > 0) {
      out += translateEvent(buffer);
      buffer = "";
    }
    return out;
  };

  const translateEvent = (raw: string): string => {
    const data = raw
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data.length === 0) return "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return "";
    }
    return isRecord(parsed) ? handle(parsed) : "";
  };

  return {
    push(text: string): string {
      buffer += lineEndings.push(text);
      return drain(false);
    },
    flush(): string {
      buffer += lineEndings.push("", true);
      return drain(true);
    },
  };
}

function errorEvent(status: number | null, message: string): string {
  return `data: ${JSON.stringify({ error: { ...(status !== null ? { code: status } : {}), message } })}\n\n`;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
