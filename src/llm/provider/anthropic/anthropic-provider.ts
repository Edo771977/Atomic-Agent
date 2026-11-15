import {
  OpenAiProvider,
  type OpenAiProviderOptions,
  type OpenAiWireDialect,
} from "../openai/openai-provider.js";
import { OpenAiHttpError } from "../openai/openai-http.js";
import { toAnthropicMessagesBody } from "./anthropic-messages-body.js";
import {
  ANTHROPIC_REFUSAL_STATUS,
  AnthropicRefusal,
  anthropicMessageToOpenAi,
} from "./anthropic-messages-response.js";
import { createAnthropicStreamConsumer } from "./anthropic-stream-consumer.js";

export const DEFAULT_ANTHROPIC_BASE = "https://api.anthropic.com";
/** The API version raw HTTP sends (`anthropic-version`), pinned. */
export const ANTHROPIC_API_VERSION = "2026-10-21";
/**
 * The version the old OpenAI-compatible preset pinned on saved entries.
 * Read as "unset": it was the preset's choice, not the operator's.
 */
export const LEGACY_PRESET_ANTHROPIC_VERSION = "2023-06-01";
export const ANTHROPIC_MESSAGES_PATH = "/v1/messages";

export type AnthropicProviderOptions = Omit<
  OpenAiProviderOptions,
  "baseUrl" | "apiPathPrefix" | "providerKind" | "wire" | "streamConsumer"
> & {
  baseUrl?: string;
};

/**
 * Native Anthropic Messages API client (`POST {baseUrl}/v1/messages`).
 *
 * Raw HTTP through the shared OpenAI-compatible transport, not the SDK:
 * the runtime needs `requestBudget.beforeSend` on the final serialized
 * body before every physical send (retries included), the process-wide
 * undici dispatcher (offline mode refuses there), and its own retry,
 * `retry-after` and fallback classification (`openai-http.ts`,
 * `should-advance.ts`). See `anthropic-messages-body.ts` and
 * `anthropic-messages-response.ts` for the wire mapping.
 */
export class AnthropicProvider extends OpenAiProvider {
  constructor(options: AnthropicProviderOptions) {
    const explicitKeys = new Set([
      ...Object.keys(options.extraBody ?? {}),
      ...Object.keys(options.modelParams ?? {}),
    ]);
    const wire: OpenAiWireDialect = {
      chatPath: ANTHROPIC_MESSAGES_PATH,
      toWireBody: (body) => toAnthropicMessagesBody(body, { explicitKeys }),
      fromWireResponse: (json, context) => {
        try {
          return anthropicMessageToOpenAi(json);
        } catch (err) {
          if (!(err instanceof AnthropicRefusal)) throw err;
          throw new OpenAiHttpError(
            `openai provider ${ANTHROPIC_REFUSAL_STATUS}: ${err.message}`,
            ANTHROPIC_REFUSAL_STATUS,
            context.url,
            false,
            null,
            context.label,
          );
        }
      },
    };
    super({
      ...options,
      baseUrl: normalizeAnthropicBaseUrl(options.baseUrl ?? DEFAULT_ANTHROPIC_BASE),
      apiPathPrefix: "/v1",
      providerKind: "anthropic",
      apiKeyHeader: options.apiKeyHeader ?? "x-api-key",
      headers: anthropicHeaders(options.headers),
      streamConsumer: createAnthropicStreamConsumer(options.reasoningFormat ?? "auto"),
      wire,
    });
  }
}

/** Stored without `/v1`, like every compat root: the routes append it. */
export function normalizeAnthropicBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed.slice(0, -3) : trimmed;
}

/**
 * The entry's headers with `anthropic-version` settled: the operator's
 * own value wins, except the old preset's pinned `2023-06-01`, which is
 * moved to the current version.
 */
export function anthropicHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  let version: string | undefined;
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (name.trim().toLowerCase() === "anthropic-version") {
      version = value.trim();
      continue;
    }
    out[name] = value;
  }
  out["anthropic-version"] =
    version === undefined || version.length === 0 || version === LEGACY_PRESET_ANTHROPIC_VERSION
      ? ANTHROPIC_API_VERSION
      : version;
  return out;
}
