/**
 * An API key that cannot be a real one: a placeholder copied from a
 * template or from our own docs (`$env:ANTHROPIC_API_KEY="..."`), a value
 * with whitespace inside, or (under the strict rule for cloud vendors
 * whose real keys are long) one far too short. Such a value is never
 * sent: a 401 for "..." reads as "your key was rejected" and hides the
 * valid key in `<stateDir>/.env` that the shell value overrode.
 *
 * Returns a short reason ("looks like a placeholder", "contains
 * whitespace", "is too short") or `null`. Never echoes the value.
 */
export function describeMalformedApiKey(
  value: string,
  opts: { readonly strictLength?: boolean } = {},
): string | null {
  const v = value.trim();
  if (v.length === 0) return null;
  if (PLACEHOLDER_PATTERNS.some((re) => re.test(v))) return "looks like a placeholder";
  if (/\s/.test(v)) return "contains whitespace";
  if (opts.strictLength === true && v.length < MIN_CLOUD_KEY_LENGTH) return "is too short";
  return null;
}

/** Real Anthropic, OpenRouter, Gemini and AIML API keys are all well over this. */
export const MIN_CLOUD_KEY_LENGTH = 20;

/**
 * The variables of cloud vendors whose keys are long: the strict length
 * rule applies to them. Shared or local variables (OPENAI_*, LMSTUDIO_*,
 * a llama-server key) can legitimately hold a short value.
 */
export const STRICT_CLOUD_KEY_VARS: ReadonlySet<string> = new Set([
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "AIMLAPI_API_KEY",
]);

/** Variable names treated as secrets by the `.env` placeholder fallback. */
export function isSecretVariableName(name: string): boolean {
  return /(?:_API_KEY|_TOKEN|_SECRET)$/.test(name);
}

const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /\.\.\./,
  /…/,
  /^<.*>$/,
  /^\{.*\}$/,
  /^\$\{.*\}$/,
  /^(?:your|my|insert|enter|paste|put)[-_ ]?(?:your[-_ ]?)?(?:[a-z]+[-_ ])?(?:api[-_ ]?)?(?:key|token)\b/i,
  /^x{3,}$/i,
  /^(?:changeme|placeholder|todo|none|null|undefined|key|api[-_]?key|token|secret)$/i,
];
