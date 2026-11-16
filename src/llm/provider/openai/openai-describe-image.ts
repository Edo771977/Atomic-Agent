import type { VisionRequest, VisionResult } from "../llm-provider.js";
import type { OpenAiHttpDeps } from "./openai-http.js";
import { openAiPostJson } from "./openai-http.js";
import { normaliseMessageContent, normaliseOpenAiUsage } from "./openai-normalise-response.js";
import { modelParamProfile, resolveTemperature } from "./model-params.js";

/**
 * The provider's body passthrough, applied to the describe call the way
 * `buildOpenAiChatBody` applies it to a turn: `extraBody`, then the
 * model's own `params`, with the request's identity restored on top.
 */
export interface DescribeImageBodyOptions {
  extraBody?: Record<string, unknown>;
  modelParams?: Record<string, unknown>;
  /**
   * The provider's chat wire when it is not chat completions (the
   * Anthropic Messages API, `OpenAiProviderOptions.wire`): the body is
   * translated last and posted to its route, and the reply translated
   * back, exactly as for a unary turn. Image parts become native image
   * blocks (`image_url` data URL → base64 source).
   */
  wire?: {
    readonly chatPath: string;
    toWireBody(body: Record<string, unknown>): Record<string, unknown>;
    fromWireResponse(
      json: Record<string, unknown>,
      context: { url: string; label: string },
    ): Record<string, unknown>;
  };
}

const RESERVED_KEYS = ["model", "messages", "stream", "tools"] as const;

export async function describeImageViaOpenAi(
  deps: OpenAiHttpDeps,
  defaultChatModel: string,
  request: VisionRequest,
  apiPathPrefix = "/v1",
  providerPreferences?: Record<string, unknown>,
  bodyOptions: DescribeImageBodyOptions = {},
): Promise<VisionResult> {
  const userContent: Array<
    | { type: "image_url"; image_url: { url: string } }
    | { type: "text"; text: string }
  > = [];
  for (const img of request.images) {
    const b64 = Buffer.from(img.bytes).toString("base64");
    userContent.push({
      type: "image_url",
      image_url: { url: `data:${img.mimeType};base64,${b64}` },
    });
  }
  userContent.push({ type: "text", text: request.prompt });
  // Same per-model rules as a turn (`model-params.ts`): OpenAI's
  // reasoning models get no temperature and `max_completion_tokens`,
  // the newer Claude models get no temperature, Kimi K3.1 gets its one
  // allowed temperature.
  // A pinned model (a fusion team member's, issue #40) wins over the
  // provider's default; its own parameter rules apply.
  const model = request.model ?? defaultChatModel;
  const profile = modelParamProfile(model);
  const temperature = resolveTemperature(profile, request.temperature, 0.1);
  const base: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: userContent }],
    // Reasoning models (Qwen3.8, DeepSeek-R1) spend completion tokens on
    // their think channel before any visible description. The old 512
    // cap left them truncating mid-thought and returning empty or
    // clipped descriptions, which sent the agent loop into re-crop
    // spirals. 4096 leaves room for thinking plus a detailed answer.
    [profile.capField]: request.maxTokens ?? 4096,
    ...(temperature !== undefined ? { temperature } : {}),
    stream: false,
    // The operator's images go wherever the turns go: routing is where
    // `data_collection` / `only` / `ignore` live, and a describe call is
    // as much a chat completion as a turn.
    ...(providerPreferences ? { provider: providerPreferences } : {}),
  };
  const body = withPassthrough(base, bodyOptions, profile);
  const wire = bodyOptions.wire;
  const path = wire ? wire.chatPath : `${apiPathPrefix}/chat/completions`;
  const start = Date.now();
  const sent = await openAiPostJson(
    deps,
    path,
    wire ? wire.toWireBody(body) : body,
    request,
  );
  const json = wire
    ? wire.fromWireResponse(sent, { url: `${deps.baseUrl}${path}`, label: deps.label })
    : sent;
  const message =
    (
      json.choices as Array<{ message?: Record<string, unknown> }> | undefined
    )?.[0]?.message ?? {};
  let text = normaliseMessageContent(message.content).trim();
  // Reasoning-only response: the model answered inside its think channel
  // and left `content` empty. The reasoning body is the best available
  // description — better than returning an empty string the tool caller
  // treats as "saw nothing".
  if (text.length === 0 && typeof message.reasoning_content === "string") {
    text = message.reasoning_content.trim();
  }
  const usage = json.usage === undefined || json.usage === null
    ? undefined
    : normaliseOpenAiUsage(json.usage as Record<string, unknown>);
  return { text, durationMs: Date.now() - start, ...(usage === undefined ? {} : { usage }) };
}

function withPassthrough(
  base: Record<string, unknown>,
  options: DescribeImageBodyOptions,
  profile: ReturnType<typeof modelParamProfile>,
): Record<string, unknown> {
  if (!options.extraBody && !options.modelParams) return base;
  const merged: Record<string, unknown> = {
    ...base,
    ...options.extraBody,
    ...options.modelParams,
  };
  for (const key of RESERVED_KEYS) {
    if (key in base) merged[key] = base[key];
    else delete merged[key];
  }
  // A temperature a service named in a 400 beats the passthrough, as in
  // `buildOpenAiChatBody`.
  if (profile.temperature.kind === "fixed" && profile.temperature.learned) {
    merged.temperature = profile.temperature.value;
  } else if (
    profile.temperature.kind === "forbidden" &&
    profile.temperature.learned
  ) {
    delete merged.temperature;
  }
  return merged;
}
