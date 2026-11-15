# Native Anthropic Messages provider

Status: current
Owner: src/llm/provider/anthropic/

The `anthropic` provider kind talks to the Anthropic Messages API
(`POST {baseUrl}/v1/messages`) directly. Anthropic's OpenAI-compatible
endpoint, which the `anthropic` preset used before, does not prompt-cache,
ignores `reasoning_effort`, returns empty usage details and never returns
thinking: every step paid full input price and Fable ran at the service's
default effort.

## Why raw HTTP, not the SDK

`AnthropicProvider` extends `OpenAiProvider` with a wire dialect
(`OpenAiProviderOptions.wire`) and reuses the shared transport in
`openai/openai-http.ts`, deliberately not `@anthropic-ai/sdk`:

- `requestBudget.beforeSend` must see the final serialized body before
  every physical send, retries included, and may clamp `max_tokens`;
- requests must go through the global undici dispatcher, which is where
  offline mode refuses them (`offline-network.ts`);
- retry, `retry-after`, 529 overload and fallback classification are the
  runtime's own (`openai-http.ts`, `fallback/should-advance.ts`).

## Request mapping

The body is built by `buildOpenAiChatBody` (native message layout, tool
names, strict tools, effort, cache breakpoints, `extraBody`, model
`params`) and translated last by `toAnthropicMessagesBody`:

- `system` messages → top-level `system` text blocks. The stable prefix is
  the first block and carries `cache_control: {type: "ephemeral"}`; tools
  render before system, so that breakpoint caches tools + system. Tool
  order is the request's own, which is deterministic per role.
- The second breakpoint is on the last history block before the
  step-mutable tail (the builder's placement), at most two of the four
  Anthropic allows.
- Assistant `tool_calls` → `tool_use`; all `tool` messages of one step →
  `tool_result` blocks in one user message, before the tail text. A result
  recorded with status `error` is sent with `is_error: true`: the status
  rides on the `tool` message under a symbol key (`TOOL_RESULT_STATUS`,
  never serialized), so a successful result whose text starts with
  `error: ` stays a success. Only a message without it (a chat-shaped
  request) falls back to our renderer's `error: ` prefix.
- `tools` → `{name, description, input_schema}`; `tool_choice` is only
  `auto` (with `disable_parallel_tool_use` when parallel calls are off) or
  `none`. Forced `any` / `tool` is a 400 on Fable 5.x, Opus 5.5 and
  Sonnet 5.5.
- `max_tokens` is always sent: the request's cap, the turn's, the entry's
  `maxOutputTokens`, else 32 000. Never the context window.
- `temperature`, `top_p`, `top_k` are sent only when the entry's
  `extraBody` or `userModels[].params` sets them and the entry pins an
  `anthropic-version` older than `2026-10-21`; that version rejects them
  on every model, so on it they are left out.
- Other explicit keys are copied as written only when they are Messages
  fields (`PASSTHROUGH_KEYS`: `metadata`, `stop_sequences`,
  `service_tier`, `thinking`, `inference_geo`, `speed`, `cache_control`,
  `container`, `mcp_servers`, `context_management`). Compat-era OpenAI
  keys are translated: `max_completion_tokens` → `max_tokens` (when no cap
  is set), `reasoning_effort` → `output_config.effort` (clamped; the
  entry's own `output_config.effort` wins), `parallel_tool_calls: false`
  → `disable_parallel_tool_use`. Every other key (`n`, `seed`,
  `presence_penalty`, `frequency_penalty`, `logit_bias`, `stream_options`,
  `user`, unknown ones) is dropped. Each dropped key is warned about once
  per provider instance.
- `response_format` (sub-calls) → `output_config.format`.
- Headers: the key in `x-api-key` (or the entry's `apiKeyHeader`),
  `anthropic-version: 2026-10-21` unless the entry pins another value (the
  old preset's `2023-06-01` counts as unpinned), `content-type`. The key is
  never logged.

## Responses

`anthropic-messages-response.ts` turns a unary message and the SSE stream
into the OpenAI shapes the shared normaliser and stream consumer read, so
both paths agree:

- usage: `input_tokens + cache_read_input_tokens +
  cache_creation_input_tokens` is the prompt; cache reads are
  `cachedTokens` / `cacheHitTokens`, cache writes `cacheWriteTokens`.
- stop reasons: `tool_use` → `tool_calls`, `max_tokens` → `length`
  (truncated), `refusal` → a typed 403 moderation-style failure whose
  message names the category. A refused stream fails, so none of its tool
  calls run.
- SSE: `message_start`, `content_block_start/delta` (`text_delta`,
  `input_json_delta`, `thinking_delta`), `message_delta`, `message_stop`
  (→ `[DONE]`), `error` (type → status: 400, 401, 403, 404, 413, 429, 500,
  529 overloaded) and `ping`.

## Preset and migration of old entries

The `anthropic` preset still saves an `openai-compatible` entry on
`https://api.anthropic.com` (now with `anthropic-version: 2026-10-21`).
At provider construction, an `openai-compatible` entry whose host is
exactly `api.anthropic.com` (with or without `/v1`, any letter case) is
built as the native client (`anthropic-route.ts`); `config.json` is not
rewritten, so key resolution (`ANTHROPIC_API_KEY` via `apiKeyEnvVar`),
model mode and the wizard read it as before. A gateway, another
Anthropic host or `qwen-openai-compatible` keeps chat completions.
`kind: "anthropic"` can also be written explicitly (`baseUrl` optional;
the key from `apiKey`, `apiKeyEnvVar` or `ANTHROPIC_API_KEY`).

Not moved: the wizard's key check and contract probe, and `describeImage`,
still use Anthropic's OpenAI-compatible routes, which accept the same key.

## Effort and thinking

Thinking is always on for Fable 5.x and Opus 5.5, so no `thinking`
parameter is sent (an entry may still pass one through `extraBody`).
Effort is `output_config.effort`, only for models that take it (Opus 4.5+,
Sonnet 4.6+, Haiku 5+, every Fable and Mythos), clamped down to the model's
levels (`anthropicEffortLevels` in `openai/model-params.ts`):

- a person's level (`reasoningOverride`) beats the entry's `params` /
  `extraBody` effort, keeping their other `output_config` fields;
- else the turn's `reasoningEffort`; on a fusion orchestrator turn
  without one, `llm.runMode.fusion.orchestratorReasoning`
  (`low|medium|high|xhigh|max`, unset by default; other kinds receive
  `xhigh` / `max` as `high`);
- else `defaultReasoningEffort`: `medium` for Fable 5.2 and later;
- a request that asked for no thinking (`disableThinking`: compaction, the
  risk reviewer) gets `low`, since thinking cannot be disabled.

Thinking blocks are never replayed: `reasoning_content` is dropped from
history. The packer, compaction and per-step tails edit the history, and
on Fable 5.2 (every account) and Opus 5.5 a replayed block whose prefix
changed is a 400. The cost is that each step re-thinks without its earlier
reasoning. Thinking text never becomes reply content.

`reasoningControlFor` reports `effort` for this kind and `none` for an
OpenAI-compatible route to an Anthropic host, which ignored the field.
