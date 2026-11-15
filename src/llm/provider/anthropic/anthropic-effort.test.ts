import { describe, expect, it, vi } from "vitest";

import type { CompletionRequest } from "../completion-types.js";
import { AnthropicProvider } from "./anthropic-provider.js";

type Sent = { body: Record<string, unknown> };

const MESSAGE = {
  id: "msg_1",
  type: "message",
  model: "m",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
};

const json = (body: unknown) => () =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

function provider(
  sent: Sent[],
  _replies: Array<() => Response>,
  extra: Partial<ConstructorParameters<typeof AnthropicProvider>[0]> = {},
): AnthropicProvider {
  return new AnthropicProvider({
    id: "anthropic",
    apiKey: "k",
    defaultChatModel: "claude-fable-5-2",
    fetchImpl: vi.fn(async (_url: string, init?: RequestInit) => {
      sent.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return json(MESSAGE)();
    }) as unknown as typeof fetch,
    ...extra,
  });
}

describe("AnthropicProvider effort", () => {
  const effortOf = async (
    model: string,
    request: Partial<CompletionRequest>,
  ): Promise<unknown> => {
    const sent: Sent[] = [];
    await provider(sent, [json(MESSAGE)], { defaultChatModel: model }).complete({ prompt: "hi", ...request });
    expect(sent[0]!.body).not.toHaveProperty("thinking");
    expect(sent[0]!.body).not.toHaveProperty("reasoning_effort");
    return (sent[0]!.body.output_config as Record<string, unknown> | undefined)?.effort;
  };

  it("defaults Fable 5.2 to medium, and leaves other models at the service default", async () => {
    expect(await effortOf("claude-fable-5-2", {})).toBe("medium");
    expect(await effortOf("claude-opus-5-5", {})).toBeUndefined();
  });

  it("sends the turn's effort, xhigh and max included", async () => {
    expect(await effortOf("claude-fable-5-2", { reasoningEffort: "high" })).toBe("high");
    expect(await effortOf("claude-fable-5-2", { reasoningEffort: "xhigh" })).toBe("xhigh");
    expect(await effortOf("claude-opus-5-5", { reasoningEffort: "max" })).toBe("max");
  });

  it("clamps a level the model does not take", async () => {
    expect(await effortOf("claude-opus-4-5", { reasoningEffort: "max" })).toBe("high");
    expect(await effortOf("claude-sonnet-4-6", { reasoningEffort: "xhigh" })).toBe("high");
    expect(await effortOf("claude-sonnet-4-6", { reasoningEffort: "max" })).toBe("max");
    expect(await effortOf("claude-haiku-4-5", { reasoningEffort: "high" })).toBeUndefined();
  });

  it("lets the person's level beat the turn's and the entry's", async () => {
    const sent: Sent[] = [];
    await provider(sent, [json(MESSAGE)], { modelParams: { output_config: { effort: "max" } } }).complete({
      prompt: "hi",
      reasoningOverride: "low",
    });
    expect(sent[0]!.body.output_config).toEqual({ effort: "low" });
  });

  it("turns a no-thinking request into effort low (thinking cannot be disabled)", async () => {
    expect(await effortOf("claude-fable-5-2", { disableThinking: true })).toBe("low");
    expect(await effortOf("claude-opus-5-5", { disableThinking: true, reasoningEffort: "high" })).toBe("low");
  });
});

