import type { LlmProviderConfigEntry, UserModelConfigEntry } from "../registry/provider-types.js";
import { effectiveEntryUrl } from "../anthropic/anthropic-route.js";

type Pricing = NonNullable<UserModelConfigEntry["pricing"]>;

/**
 * Anthropic's first-party list prices (issue #29 item 9), USD per million
 * tokens: base input, 5-minute cache write, cache hit, output. Copied by
 * hand from the official page, https://platform.claude.com/docs/en/about-claude/pricing,
 * on the date below; the page is the only source. Refresh this table from
 * that page (and move the date) when Anthropic changes a price or ships a
 * model. Unlike the models.dev snapshot these count as verified pricing
 * for admission, but only for an entry that calls the first-party host
 * (`ANTHROPIC_FIRST_PARTY_HOST`): Bedrock, Vertex and OpenRouter set their
 * own prices.
 *
 * Not modelled: 1-hour cache writes (2x input; settled at the 5-minute
 * rate), the Batch API discount, and the data-residency premium of
 * partner platforms.
 */
export const ANTHROPIC_OFFICIAL_PRICES_DATE = "2026-11-15";
export const ANTHROPIC_OFFICIAL_PRICES_SOURCE = `anthropic-official ${ANTHROPIC_OFFICIAL_PRICES_DATE}`;
export const ANTHROPIC_FIRST_PARTY_HOST = "api.anthropic.com";

const PRICES: Readonly<Record<string, Pricing>> = {
  "claude-fable-5-2": { input: 8, cacheWrite: 10, cacheRead: 0.2, output: 40 },
  "claude-opus-5-5": { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 },
  "claude-sonnet-5-5": { input: 2, cacheWrite: 2.5, cacheRead: 0.1, output: 10 },
  // Priced by prompt length: a prompt over 100,000 tokens (cache reads and
  // writes included) pays the higher rates for the whole request.
  "claude-haiku-5-5": {
    input: 0.1, cacheWrite: 0.125, cacheRead: 0.01, output: 0.5,
    longContext: { thresholdTokens: 100_000, input: 0.5, cacheWrite: 0.625, cacheRead: 0.05, output: 2.5 },
  },
  "claude-opus-5": { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  "claude-opus-4-8": { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  "claude-sonnet-5": { input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 },
  "claude-sonnet-4-6": { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  "claude-haiku-4-5": { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 },
};

/**
 * Fast mode (`speed: "fast"`): the official page lists these models only,
 * each at twice its base input and output rate; cache multipliers apply
 * on top, so cache rates double too.
 */
const FAST_MODE_MULTIPLIER: Readonly<Record<string, number>> = {
  "claude-fable-5-2": 2, // $16 / $80
  "claude-opus-5-5": 2, // $8 / $40
  "claude-opus-5": 2, // $10 / $50
  "claude-opus-4-8": 2, // $10 / $50
};

/** `inference_geo: "us"` on Claude 4.6 and later: 1.1x every token category. */
const US_INFERENCE_MULTIPLIER = 1.1;
/** Models older than Claude 4.6 reject `inference_geo` (400). */
const NO_INFERENCE_GEO = new Set(["claude-haiku-4-5"]);

/** `claude-haiku-4-5-20251001` → `claude-haiku-4-5`: a dated snapshot of a listed model. */
function baseModelId(modelId: string): string {
  const id = modelId.toLowerCase();
  const dated = /^(.*)-\d{8}$/.exec(id);
  return dated !== null && Object.hasOwn(PRICES, dated[1]!) ? dated[1]! : id;
}

function hostOf(url: string | undefined): string | undefined {
  if (url === undefined || url.trim() === "") return undefined;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function scale(pricing: Pricing, factor: number): Pricing {
  if (factor === 1) return pricing;
  const rates = (p: { input: number; output: number; cacheRead?: number; cacheWrite?: number }) => ({
    input: p.input * factor,
    ...(p.cacheWrite === undefined ? {} : { cacheWrite: p.cacheWrite * factor }),
    ...(p.cacheRead === undefined ? {} : { cacheRead: p.cacheRead * factor }),
    output: p.output * factor,
  });
  return {
    ...rates(pricing),
    ...(pricing.longContext === undefined ? {} : { longContext: { thresholdTokens: pricing.longContext.thresholdTokens, ...rates(pricing.longContext) } }),
  };
}

/**
 * The official price of `modelId` on `entry`, or `undefined` when the
 * entry does not call Anthropic's first-party API, the model is not in
 * the table, or the request carries a price modifier the table cannot
 * price (fast mode on a model without it, an unknown `speed` or
 * `inference_geo`). Modifiers are read from the entry's `extraBody` and
 * the model's `params`, the two places a request picks them up.
 */
export function anthropicOfficialPricing(
  entry: Pick<LlmProviderConfigEntry, "kind" | "baseUrl" | "url" | "extraBody" | "userModels">,
  modelId: string,
): Pricing | undefined {
  if (entry.kind === "subscription-cli" || entry.kind === "llama-server") return undefined;
  if (hostOf(effectiveEntryUrl(entry)) !== ANTHROPIC_FIRST_PARTY_HOST) return undefined;
  const id = baseModelId(modelId);
  const base = Object.hasOwn(PRICES, id) ? PRICES[id] : undefined;
  if (base === undefined) return undefined;
  const params = entry.userModels?.find((m) => m.id === modelId)?.params;
  const read = (field: string): unknown => params?.[field] ?? entry.extraBody?.[field];
  let factor = 1;
  const speed = read("speed");
  if (speed !== undefined && speed !== null && speed !== "standard") {
    const fast = speed === "fast" ? FAST_MODE_MULTIPLIER[id] : undefined;
    if (fast === undefined) return undefined;
    factor *= fast;
  }
  const geo = read("inference_geo");
  if (geo !== undefined && geo !== null && geo !== "global") {
    if (geo !== "us" || NO_INFERENCE_GEO.has(id)) return undefined;
    factor *= US_INFERENCE_MULTIPLIER;
  }
  return scale(base, factor);
}
