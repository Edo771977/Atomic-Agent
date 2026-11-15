/**
 * Model discovery and the key check for a native Anthropic entry:
 * `GET {base}/v1/models` with the key in `x-api-key` (or the entry's
 * `apiKeyHeader`) and the `anthropic-version` the Messages client sends
 * (`anthropicHeaders`). An `openai-compatible` entry on
 * `api.anthropic.com` (the old preset) counts as native here too
 * (`effectiveProviderKind`), so its listing upgrades with its turns.
 */

import { fetchOpenAiCompatModels } from "../openai/fetch-openai-compat-models.js";
import type { OpenAiCompatAuth } from "../openai/openai-auth-headers.js";
import { anthropicHeaders, normalizeAnthropicBaseUrl } from "./anthropic-provider.js";
import { DEFAULT_ANTHROPIC_BASE, effectiveProviderKind } from "./anthropic-route.js";

/** The listing page Anthropic serves by default is 20 ids; this is its maximum. */
export const ANTHROPIC_MODELS_QUERY = "?limit=1000";

type EntryAuth = {
  readonly kind: string;
  readonly baseUrl?: string | undefined;
  readonly apiKeyHeader?: string | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
};

/** Whether an entry is served by the native Messages client. */
export function isNativeAnthropicEntry(entry: Pick<EntryAuth, "kind" | "baseUrl">): boolean {
  return effectiveProviderKind(entry) === "anthropic";
}

/** How a native entry's requests authenticate: `x-api-key` and the settled `anthropic-version`. */
export function anthropicAuth(entry?: Pick<EntryAuth, "apiKeyHeader" | "headers">): OpenAiCompatAuth {
  return {
    apiKeyHeader: entry?.apiKeyHeader?.trim() || "x-api-key",
    headers: anthropicHeaders(entry?.headers ? { ...entry.headers } : undefined),
  };
}

/** `GET {base}/v1/models` for a native entry (default host when it has no `baseUrl`). */
export function fetchAnthropicModels(
  apiKey: string | undefined,
  entry?: Pick<EntryAuth, "baseUrl" | "apiKeyHeader" | "headers">,
): Promise<readonly string[]> {
  const base = normalizeAnthropicBaseUrl(entry?.baseUrl?.trim() || DEFAULT_ANTHROPIC_BASE);
  return fetchOpenAiCompatModels(base, apiKey, anthropicAuth(entry), ANTHROPIC_MODELS_QUERY);
}
