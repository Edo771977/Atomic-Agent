import { describe, expect, it, vi } from "vitest";

import type { CompletionRequest, PromptMessages } from "../completion-types.js";
import { OfflineNetworkError, isOfflineRefusal } from "../../offline-network.js";
import { OpenAiHttpError, isModerationRefusal } from "../openai/openai-http.js";
import { shouldAdvance } from "../../fallback/should-advance.js";
import { AnthropicProvider } from "./anthropic-provider.js";
import { ImageRejectedAsTooLargeError } from "../model-vision-rejections.js";

type Sent = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

const MESSAGE = {
  id: "msg_1",
  type: "message",
  model: "claude-fable-5-2",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 900,
    cache_creation_input_tokens: 100,
  },
};

function fakeFetch(
  replies: Array<() => Response>,
  sent: Sent[],
): typeof fetch {
  let i = 0;
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    sent.push({
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const reply = replies[Math.min(i, replies.length - 1)]!;
    i += 1;
    return reply();
  }) as unknown as typeof fetch;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

function sse(events: Array<Record<string, unknown>>): () => Response {
  const text = events
    .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  return () =>
    new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function provider(
  sent: Sent[],
  replies: Array<() => Response>,
  extra: Partial<ConstructorParameters<typeof AnthropicProvider>[0]> = {},
): AnthropicProvider {
  return new AnthropicProvider({
    id: "anthropic",
    apiKey: "sk-ant-test",
    defaultChatModel: "claude-fable-5-2",
    fetchImpl: fakeFetch(replies, sent),
    ...extra,
  });
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "os__fs__read",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: { name: "reply", description: "Reply", parameters: { type: "object", properties: {} } },
  },
];

const PROMPT: PromptMessages = {
  system: "STABLE PREFIX",
  droppedSummary: null,
  turns: [
    { kind: "user", text: "read two files" },
    { kind: "assistant_tool_call", tool: "os.fs.read", args: { path: "a" }, callId: "call_turn_1" },
    { kind: "assistant_tool_call", tool: "os.fs.read", args: { path: "b" }, callId: "call_turn_2" },
    { kind: "tool_result", tool: "os.fs.read", status: "ok", body: "A", truncated: false, callId: "call_turn_1" },
    { kind: "tool_result", tool: "os.fs.read", status: "error", body: "ENOENT", truncated: false, callId: "call_turn_2" },
  ],
  tail: "Respond now.",
};

function turnRequest(extra: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    prompt: "flat",
    messages: PROMPT,
    tools: TOOLS,
    ...extra,
  };
}

describe("AnthropicProvider request", () => {
  it("posts to /v1/messages with x-api-key and the pinned anthropic-version", async () => {
    const sent: Sent[] = [];
    await provider(sent, [json(MESSAGE)]).complete({ prompt: "hi" });
    expect(sent[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(sent[0]!.headers["x-api-key"]).toBe("sk-ant-test");
    expect(sent[0]!.headers.authorization).toBeUndefined();
    expect(sent[0]!.headers["anthropic-version"]).toBe("2026-10-21");
    expect(sent[0]!.headers["content-type"]).toBe("application/json");
  });

  it("keeps an operator's anthropic-version but moves the old preset's pin", async () => {
    const sent: Sent[] = [];
    await provider(sent, [json(MESSAGE)], { headers: { "anthropic-version": "2023-06-01", "x-extra": "1" } })
      .complete({ prompt: "hi" });
    expect(sent[0]!.headers["anthropic-version"]).toBe("2026-10-21");
    expect(sent[0]!.headers["x-extra"]).toBe("1");
    const own: Sent[] = [];
    await provider(own, [json(MESSAGE)], { headers: { "Anthropic-Version": "2025-01-01" } })
      .complete({ prompt: "hi" });
    expect(own[0]!.headers["anthropic-version"]).toBe("2025-01-01");
  });

  it("lays the stable prefix out as a cached system block and groups one step's results", async () => {
    const sent: Sent[] = [];
    await provider(sent, [json(MESSAGE)]).complete(turnRequest({ modelMode: { mode: "cloud" } as never }));
    const body = sent[0]!.body;
    expect(body.system).toEqual([
      { type: "text", text: "STABLE PREFIX", cache_control: { type: "ephemeral" } },
    ]);
    const messages = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[1]!.content).toEqual([
      { type: "tool_use", id: "call_turn_1", name: "os__fs__read", input: { path: "a" } },
      { type: "tool_use", id: "call_turn_2", name: "os__fs__read", input: { path: "b" } },
    ]);
    // Both results of the step in ONE user message, before the tail text;
    // the failed call is is_error; the breakpoint sits on the last result,
    // not on the step-mutable tail.
    expect(messages[2]!.content).toEqual([
      { type: "tool_result", tool_use_id: "call_turn_1", content: "A" },
      {
        type: "tool_result",
        tool_use_id: "call_turn_2",
        content: "error: ENOENT",
        is_error: true,
        cache_control: { type: "ephemeral" },
      },
      { type: "text", text: "Respond now." },
    ]);
    expect(body.tools).toEqual([
      {
        name: "os__fs__read",
        description: "Read a file",
        input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
      { name: "reply", description: "Reply", input_schema: { type: "object", properties: {} } },
    ]);
    const cacheMarks = JSON.stringify(body).match(/cache_control/g) ?? [];
    expect(cacheMarks.length).toBeLessThanOrEqual(4);
  });

  it("marks is_error from the tool result's own status, not from its text", async () => {
    const sent: Sent[] = [];
    const prompt: PromptMessages = {
      ...PROMPT,
      turns: [
        { kind: "user", text: "read two files" },
        { kind: "assistant_tool_call", tool: "os.fs.read", args: { path: "a" }, callId: "call_turn_1" },
        { kind: "assistant_tool_call", tool: "os.fs.read", args: { path: "b" }, callId: "call_turn_2" },
        // A file whose first line happens to read "error: ..." is a success.
        { kind: "tool_result", tool: "os.fs.read", status: "ok", body: "error: this line is in the log file", truncated: false, callId: "call_turn_1" },
        { kind: "tool_result", tool: "os.fs.read", status: "error", body: "ENOENT", truncated: false, callId: "call_turn_2" },
      ],
    };
    await provider(sent, [json(MESSAGE)]).complete(turnRequest({ messages: prompt }));
    const messages = sent[0]!.body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    const results = messages[2]!.content.filter((b) => b.type === "tool_result");
    expect(results[0]).not.toHaveProperty("is_error");
    expect(results[0]!.content).toBe("error: this line is in the log file");
    expect(results[1]!.is_error).toBe(true);
    // Nothing of the marker reaches the wire under its own name.
    expect(JSON.stringify(sent[0]!.body)).not.toMatch(/toolStatus|atomic/);
  });

  it("never sends sampling parameters, stream_options or a forced tool_choice", async () => {
    const sent: Sent[] = [];
    await provider(sent, [json(MESSAGE)], { defaultChatModel: "claude-sonnet-4-5" }).complete(
      turnRequest({ temperature: 0.7, topP: 0.9, topK: 5, seed: 3, toolChoice: "required", parallelToolCalls: false }),
    );
    const body = sent[0]!.body;
    for (const key of ["temperature", "top_p", "top_k", "seed", "stream_options", "parallel_tool_calls", "response_format"]) {
      expect(body).not.toHaveProperty(key);
    }
    expect(body.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
  });

  it("sends an explicit sampling parameter only on an API version older than 2026-10-21", async () => {
    const sent: Sent[] = [];
    await provider(sent, [json(MESSAGE)], {
      defaultChatModel: "claude-sonnet-4-5",
      headers: { "anthropic-version": "2026-06-01" },
      extraBody: { temperature: 0.3, metadata: { user_id: "u" } },
    }).complete({ prompt: "hi" });
    expect(sent[0]!.body.temperature).toBe(0.3);
    expect(sent[0]!.body.metadata).toEqual({ user_id: "u" });
  });

  it("drops explicit sampling parameters on the pinned 2026-10-21 version, warning once", async () => {
    const sent: Sent[] = [];
    const warn = vi.fn();
    const p = provider(sent, [json(MESSAGE)], {
      extraBody: { temperature: 0.3, top_p: 0.9 },
      modelParams: { top_k: 5 },
      logger: { warn },
    });
    await p.complete({ prompt: "hi" });
    await p.complete({ prompt: "hi" });
    for (const body of sent.map((s) => s.body)) {
      for (const key of ["temperature", "top_p", "top_k"]) expect(body).not.toHaveProperty(key);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/temperature/);
  });

  it("translates or drops compat-era OpenAI-only extraBody keys instead of forwarding them", async () => {
    const sent: Sent[] = [];
    const warn = vi.fn();
    const p = provider(sent, [json(MESSAGE)], {
      extraBody: {
        max_completion_tokens: 2000,
        reasoning_effort: "high",
        presence_penalty: 0.1,
        frequency_penalty: 0.2,
        n: 1,
        seed: 7,
        logit_bias: { "1": 2 },
        stream_options: { include_usage: true },
        parallel_tool_calls: false,
        user: "someone",
        some_future_openai_knob: true,
        metadata: { user_id: "u" },
        service_tier: "auto",
        inference_geo: "us",
      },
      logger: { warn },
    });
    await p.complete(turnRequest());
    await p.complete(turnRequest());
    const body = sent[0]!.body;
    expect(body.max_tokens).toBe(2000);
    expect(body.output_config).toMatchObject({ effort: "high" });
    for (const key of [
      "max_completion_tokens", "reasoning_effort", "presence_penalty", "frequency_penalty", "n",
      "seed", "logit_bias", "stream_options", "parallel_tool_calls", "user", "some_future_openai_knob",
    ]) {
      expect(body).not.toHaveProperty(key);
    }
    expect(body.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
    expect(body.metadata).toEqual({ user_id: "u" });
    expect(body.service_tier).toBe("auto");
    expect(body.inference_geo).toBe("us");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/presence_penalty/);
  });

  it("always sends max_tokens: the request cap, the entry ceiling, else the default", async () => {
    const sent: Sent[] = [];
    const p = provider(sent, [json(MESSAGE)], { maxOutputTokens: 4096 });
    await p.complete({ prompt: "hi" });
    await p.complete({ prompt: "hi", maxTokens: 1000 });
    expect(sent.map((s) => s.body.max_tokens)).toEqual([4096, 1000]);
    // Unbounded and unary: a smaller default, so a long reply cannot run
    // into the 10-minute request timeout with nothing streamed.
    const bare: Sent[] = [];
    await provider(bare, [json(MESSAGE)]).complete({ prompt: "hi" });
    expect(bare[0]!.body.max_tokens).toBe(16_000);
  });

  it("calls requestBudget.beforeSend with the final Messages body, on every physical send", async () => {
    const sent: Sent[] = [];
    const seen: Record<string, unknown>[] = [];
    const p = provider(sent, [json({ type: "error", error: { type: "api_error", message: "boom" } }, 500), json(MESSAGE)]);
    await p.complete({
      prompt: "hi",
      requestBudget: {
        beforeSend: (body) => {
          seen.push(structuredClone(body));
          body.max_tokens = 77;
        },
        onResponse: () => undefined,
      },
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toHaveProperty("messages");
    expect(seen[0]).not.toHaveProperty("stream_options");
    expect(seen[0]!.max_tokens).toBe(16_000);
    // The clamp the budget wrote is what went out.
    expect(sent.map((s) => s.body.max_tokens)).toEqual([77, 77]);
  });

  it("maps a JSON-schema sub-call to output_config.format", async () => {
    const sent: Sent[] = [];
    await provider(sent, [json(MESSAGE)]).complete({
      prompt: "classify",
      responseFormat: { name: "x", schema: { type: "object", properties: {}, additionalProperties: false } },
    });
    expect(sent[0]!.body.output_config).toMatchObject({
      format: { type: "json_schema", schema: { type: "object", properties: {}, additionalProperties: false } },
    });
  });
});

describe("AnthropicProvider responses", () => {
  it("maps usage with cache read and write into the usage shape", async () => {
    const sent: Sent[] = [];
    const result = await provider(sent, [json(MESSAGE)]).complete({ prompt: "hi" });
    expect(result.content).toBe("ok");
    expect(result.cacheHitTokens).toBe(900);
    expect(result.usage).toMatchObject({
      promptTokens: 1010,
      completionTokens: 5,
      cachedTokens: 900,
      cacheWriteTokens: 100,
    });
    expect(result.generationId).toBe("msg_1");
  });

  it("returns tool_use blocks as tool calls and drops thinking from the content", async () => {
    const sent: Sent[] = [];
    const result = await provider(sent, [
      json({
        ...MESSAGE,
        content: [
          { type: "thinking", thinking: "", signature: "sig" },
          { type: "text", text: "Reading." },
          { type: "tool_use", id: "toolu_1", name: "os__fs__read", input: { path: "a" } },
        ],
        stop_reason: "tool_use",
      }),
    ]).complete(turnRequest());
    expect(result.content).toBe("Reading.");
    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toEqual([
      { id: "toolu_1", type: "function", function: { name: "os__fs__read", arguments: '{"path":"a"}' } },
    ]);
  });

  it("marks max_tokens as truncated", async () => {
    const sent: Sent[] = [];
    const result = await provider(sent, [json({ ...MESSAGE, stop_reason: "max_tokens" })]).complete({ prompt: "hi" });
    expect(result.truncated).toBe(true);
    expect(result.finishReason).toBe("length");
  });

  it("turns a refusal into a moderation-style failure, not an answer", async () => {
    const sent: Sent[] = [];
    const err = await provider(sent, [
      json({ ...MESSAGE, content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber" } }),
    ]).complete({ prompt: "hi" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAiHttpError);
    expect((err as OpenAiHttpError).status).toBe(403);
    expect((err as OpenAiHttpError).message).toMatch(/category cyber/);
    expect(isModerationRefusal(err as OpenAiHttpError)).toBe(true);
    expect(sent).toHaveLength(1);
  });
});

describe("AnthropicProvider errors", () => {
  it("retries 529 overloaded and honours retry-after", async () => {
    vi.useFakeTimers();
    try {
      const sent: Sent[] = [];
      const pending = provider(sent, [
        json({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, 529, { "retry-after": "2" }),
        json(MESSAGE),
      ]).complete({ prompt: "hi" });
      await vi.advanceTimersByTimeAsync(1_500);
      expect(sent).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await pending;
      expect(result.content).toBe("ok");
      expect(sent).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives a 429 that asks for a long cooldown back typed, for the fallback chain", async () => {
    const sent: Sent[] = [];
    const err = await provider(sent, [
      json({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }, 429, { "retry-after": "60" }),
    ]).complete({ prompt: "hi" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAiHttpError);
    expect((err as OpenAiHttpError).status).toBe(429);
    expect((err as OpenAiHttpError).retryAfterMs).toBe(60_000);
    expect(shouldAdvance(err)).toEqual({ advance: true, immediate: true });
    expect(sent).toHaveLength(1);
  });

  it("does not retry 400/401/404/413", async () => {
    for (const [status, type] of [[400, "invalid_request_error"], [401, "authentication_error"], [404, "not_found_error"], [413, "request_too_large"]] as const) {
      const sent: Sent[] = [];
      const err = await provider(sent, [json({ type: "error", error: { type, message: "no" } }, status)])
        .complete({ prompt: "hi" }).catch((e: unknown) => e);
      expect((err as OpenAiHttpError).status).toBe(status);
      expect(sent).toHaveLength(1);
    }
  });

  it("classifies an offline-mode refusal without retrying it", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: new OfflineNetworkError("api.anthropic.com") });
    });
    const p = new AnthropicProvider({
      id: "anthropic",
      apiKey: "k",
      defaultChatModel: "claude-fable-5-2",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const err = await p.complete({ prompt: "hi" }).catch((e: unknown) => e);
    expect(isOfflineRefusal(err)).toBe(true);
    expect(shouldAdvance(err)).toEqual({ advance: true, immediate: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("AnthropicProvider streaming", () => {
  const drain = async (p: AnthropicProvider, request: CompletionRequest) => {
    const gen = p.completeStream(request);
    const chunks: string[] = [];
    for (;;) {
      const next = await gen.next();
      if (next.done) return { chunks, result: next.value };
      chunks.push(next.value.delta);
    }
  };

  it("streams text, tool_use with input_json_delta and the cache usage", async () => {
    const sent: Sent[] = [];
    const p = provider(sent, [
      sse([
        { type: "message_start", message: { id: "msg_s", model: "claude-fable-5-2", usage: { input_tokens: 12, cache_read_input_tokens: 3000, cache_creation_input_tokens: 40, output_tokens: 1 } } },
        { type: "ping" },
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "s" } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hel" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "lo" } },
        { type: "content_block_stop", index: 1 },
        { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_9", name: "os__fs__read", input: {} } },
        { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{\"pa" } },
        { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "th\":\"a\"}" } },
        { type: "content_block_stop", index: 2 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 42 } },
        { type: "message_stop" },
      ]),
    ]);
    const { chunks, result } = await drain(p, turnRequest());
    expect(sent[0]!.body.stream).toBe(true);
    // A stream keeps the larger default reply budget.
    expect(sent[0]!.body.max_tokens).toBe(32_000);
    expect(chunks.join("")).toBe("Hello");
    expect(result.content).toBe("Hello");
    expect(result.toolCalls).toEqual([
      { id: "toolu_9", type: "function", function: { name: "os__fs__read", arguments: '{"path":"a"}' } },
    ]);
    expect(result.truncated).toBe(false);
    expect(result.cacheHitTokens).toBe(3000);
    expect(result.usage).toMatchObject({ promptTokens: 3052, completionTokens: 42, cachedTokens: 3000, cacheWriteTokens: 40 });
    expect(result.generationId).toBe("msg_s");
  });

  it("reports a mid-stream overloaded error as a typed 529", async () => {
    const sent: Sent[] = [];
    const p = provider(sent, [
      sse([
        { type: "message_start", message: { id: "msg_e", model: "m", usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "par" } },
        { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
      ]),
    ]);
    const err = await drain(p, { prompt: "hi" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAiHttpError);
    expect((err as OpenAiHttpError).status).toBe(529);
    expect((err as OpenAiHttpError).streamError).toMatch(/Overloaded/);
  });

  it("fails a refused stream instead of running its tool calls", async () => {
    const sent: Sent[] = [];
    const p = provider(sent, [
      sse([
        { type: "message_start", message: { id: "msg_r", model: "m", usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "reply", input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "refusal", stop_details: { category: "bio" } }, usage: { output_tokens: 3 } },
        { type: "message_stop" },
      ]),
    ]);
    const err = await drain(p, turnRequest()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAiHttpError);
    expect((err as OpenAiHttpError).status).toBe(403);
    expect((err as OpenAiHttpError).message).toMatch(/category bio/);
  });

  it("marks a stream cut at max_tokens as truncated", async () => {
    const sent: Sent[] = [];
    const p = provider(sent, [
      sse([
        { type: "message_start", message: { id: "m", model: "m", usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "long" } },
        { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 9 } },
        { type: "message_stop" },
      ]),
    ]);
    const { result } = await drain(p, { prompt: "hi" });
    expect(result.truncated).toBe(true);
    expect(result.finishReason).toBe("length");
  });
});

describe("AnthropicProvider.describeImage", () => {
  it("sends the image as a native base64 block to /v1/messages", async () => {
    const sent: Sent[] = [];
    const p = provider(
      sent,
      [json({ ...MESSAGE, content: [{ type: "text", text: "a red square" }] })],
      { supportsVision: true },
    );
    const result = await p.describeImage({
      prompt: "What is in this image?",
      images: [{ id: 1, bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" }],
      temperature: 0.2,
    });

    expect(result.text).toBe("a red square");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(sent[0]!.headers["x-api-key"]).toBe("sk-ant-test");
    expect(sent[0]!.headers["anthropic-version"]).toBe("2026-10-21");
    expect(sent[0]!.body).toMatchObject({
      model: "claude-fable-5-2",
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
            { type: "text", text: "What is in this image?" },
          ],
        },
      ],
    });
    // Chat-completions fields stay off the native wire.
    for (const key of ["temperature", "max_completion_tokens", "stream"]) {
      expect(sent[0]!.body).not.toHaveProperty(key);
    }
  });

  it("names an oversized image instead of marking the model blind", async () => {
    const sent: Sent[] = [];
    const p = provider(sent, [
      json(
        {
          type: "error",
          error: {
            type: "invalid_request_error",
            message:
              "messages.0.content.0.image.source.base64: image exceeds 5 MB maximum: 6291456 bytes > 5242880 bytes",
          },
        },
        400,
      ),
    ]);
    expect(p.capabilities.visionSource).toBe("assumed");
    const err = await p
      .describeImage({
        prompt: "x",
        images: [{ id: 1, bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" }],
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImageRejectedAsTooLargeError);
    expect((err as Error).message).toMatch(/image is too large/i);
    expect((err as Error).message).toMatch(/vision\.maxImageBytes/);
    expect((err as Error).message).toContain("5 MB maximum");
    // One oversized image is not evidence the model cannot see.
    expect(p.capabilities).toMatchObject({ vision: true, visionSource: "assumed" });
    expect(sent).toHaveLength(1);
  });
});
