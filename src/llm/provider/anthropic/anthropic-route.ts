/**
 * Which entries run on the native Anthropic Messages client.
 *
 * Entries saved by the old `anthropic` preset are `openai-compatible` on
 * `https://api.anthropic.com` (with or without `/v1`), pointed at
 * Anthropic's OpenAI-compatible endpoint, which neither prompt-caches nor
 * honours an effort. They are routed to the native kind when the provider
 * is built, without rewriting `config.json`: the config keeps saying
 * `openai-compatible`, so key resolution, model mode and the wizard read
 * it as before. Only the exact host qualifies; a gateway or another
 * Anthropic host keeps chat completions.
 */

export const ANTHROPIC_API_HOST = "api.anthropic.com";

export function routesToNativeAnthropic(entry: {
  readonly kind: string;
  readonly baseUrl?: string | undefined;
}): boolean {
  if (entry.kind !== "openai-compatible" || !entry.baseUrl) return false;
  try {
    return new URL(entry.baseUrl.trim()).hostname.toLowerCase() === ANTHROPIC_API_HOST;
  } catch {
    return false;
  }
}

/** The kind that actually serves the entry: `anthropic` for a routed one. */
export function effectiveProviderKind(entry: {
  readonly kind: string;
  readonly baseUrl?: string | undefined;
}): string {
  return routesToNativeAnthropic(entry) ? "anthropic" : entry.kind;
}
