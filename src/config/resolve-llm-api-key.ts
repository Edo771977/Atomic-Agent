import { DEFAULT_AIMLAPI_BASE } from "../llm/provider/aimlapi/aimlapi-endpoint.js";
import { hasUnresolvedWildcardDnsAddress } from "../llm/provider/openai/local-server-url.js";
import { isOtherComputerOnNetworkUrl } from "../llm/provider/openai/network-server-address.js";
import { classifiableHostOf, isLoopbackUrl } from "../llm/provider/url-host.js";
import { describeMalformedApiKey } from "./api-key-shape.js";
import type { UserLlmProviderEntry } from "./llm-config.js";

/** Where a provider key came from. Never carries the value. */
export type LlmApiKeySource =
  | { readonly kind: "config" }
  | { readonly kind: "env"; readonly name: string };

/**
 * The key a provider entry would use and its source, or, when the only
 * candidate was malformed (`describeMalformedApiKey`: a placeholder such
 * as `...`, whitespace inside), the source
 * that was ignored, its length and why. A malformed value is never sent:
 * the entry then has no key ("missing"), not a rejected one.
 */
export interface LlmApiKeyResolution {
  readonly key?: { readonly value: string; readonly source: LlmApiKeySource };
  readonly ignored?: { readonly source: LlmApiKeySource; readonly length: number; readonly reason: string };
}

type LlmApiKeyEntry = Pick<UserLlmProviderEntry, "id" | "kind" | "baseUrl" | "apiKey" | "apiKeyEnvVar">;

/**
 * Resolve API keys for provider registry entries. File-stored `apiKey`
 * wins; otherwise well-known env vars are consulted.
 */
export function resolveLlmProviderApiKey(
  entry: LlmApiKeyEntry,
): string | undefined {
  return resolveLlmProviderApiKeyWithSource(entry).key?.value;
}

/** `resolveLlmProviderApiKey` with the key's source (doctor names it). */
export function resolveLlmProviderApiKeyWithSource(
  entry: LlmApiKeyEntry,
): LlmApiKeyResolution {
  let ignored: LlmApiKeyResolution["ignored"];
  const take = (value: string | undefined, source: LlmApiKeySource): LlmApiKeyResolution | null => {
    if (value === undefined || value.length === 0) return null;
    // No length rule here: short keys are legitimate for local servers
    // and test doubles. The `.env` loader applies it only where a
    // well-formed `.env` value is there to fall back on.
    const reason = describeMalformedApiKey(value);
    if (reason !== null) {
      ignored ??= { source, length: value.trim().length, reason };
      return null;
    }
    return { key: { value, source } };
  };
  const done = (): LlmApiKeyResolution => (ignored ? { ignored } : {});
  const fromEnv = (name: string): LlmApiKeyResolution =>
    take(process.env[name], { kind: "env", name }) ?? done();

  // A malformed stored `apiKey` falls through to the variables below.
  const stored = take(entry.apiKey, { kind: "config" });
  if (stored) return stored;
  // Entries created from a known-service preset carry their own env var
  // (`GROQ_API_KEY`, `NOUS_API_KEY`, ...). It is authoritative, without
  // a fallback to the shared per-kind variables: falling through would
  // recreate the wrong-key-for-this-endpoint pairing presets exist to
  // prevent (#69), and keyless local servers (LM Studio) rely on the
  // `undefined` here to send requests without an Authorization header.
  if (entry.apiKeyEnvVar && entry.apiKeyEnvVar.length > 0) {
    if (!mayUseKeyVariable(entry, entry.apiKeyEnvVar)) return done();
    return fromEnv(entry.apiKeyEnvVar);
  }
  const native = NATIVE_KEY_DEFAULTS.get(entry.kind);
  if (native) return mayReceiveDefaultKey(entry.baseUrl, native.origin) ? fromEnv(native.name) : done();
  if (
    entry.kind === "openai-compatible" ||
    entry.kind === "qwen-openai-compatible"
  ) {
    // The shared variables usually hold the operator's real OpenAI key:
    // never as a Bearer over plain http:// off this machine, nor to
    // another computer on the network (ATO-1066). A named OpenAI
    // variable remains subject to the OpenAI destination check.
    if (!maySendSharedOpenAiKey(entry.baseUrl)) return done();
    const shared = sharedOpenAiKey();
    if (shared === undefined || (shared.name !== "OPENAI_COMPAT_API_KEY" && !mayReceiveOpenAiKey(entry.baseUrl))) return done();
    return take(shared.value, { kind: "env", name: shared.name }) ?? done();
  }
  return done();
}

/**
 * The OpenAI or shared compatible variable withheld from this destination.
 */
export function sharedOpenAiKeyNotSent(
  entry: Pick<LlmApiKeyEntry, "kind" | "baseUrl" | "apiKey" | "apiKeyEnvVar">,
): string | undefined {
  if (entry.apiKey && describeMalformedApiKey(entry.apiKey) === null) return undefined;
  if (entry.apiKeyEnvVar) {
    return OPENAI_KEY_VARIABLES.has(entry.apiKeyEnvVar.toUpperCase()) &&
      !mayUseKeyVariable(entry, entry.apiKeyEnvVar) && process.env[entry.apiKeyEnvVar]
      ? entry.apiKeyEnvVar : undefined;
  }
  if (entry.kind !== "openai-compatible" && entry.kind !== "qwen-openai-compatible") return undefined;
  const shared = sharedOpenAiKey();
  if (shared === undefined || (maySendSharedOpenAiKey(entry.baseUrl) && (shared.name === "OPENAI_COMPAT_API_KEY" || mayReceiveOpenAiKey(entry.baseUrl)))) return undefined;
  return shared.name;
}

/** The primary native variable reserved for a different destination. */
export function blockedNativeKeyVariable(
  entry: Pick<LlmApiKeyEntry, "kind" | "baseUrl" | "apiKeyEnvVar">,
): string | undefined {
  const name = entry.apiKeyEnvVar || NATIVE_KEY_DEFAULTS.get(entry.kind)?.name;
  if (name && NATIVE_KEY_DESTINATIONS.has(name.toUpperCase()) && !mayUseKeyVariable(entry, name)) {
    return name;
  }
  return undefined;
}

/** The name of the configured or default primary key withheld by the origin guard. */
export function nativeKeyNotSent(entry: Omit<LlmApiKeyEntry, "id">): string | undefined {
  if (entry.apiKey && describeMalformedApiKey(entry.apiKey) === null) return undefined;
  const native = blockedNativeKeyVariable(entry);
  return native && process.env[native] ? native : undefined;
}

export function providerKeyNotSent(entry: Omit<LlmApiKeyEntry, "id">): string | undefined {
  return sharedOpenAiKeyNotSent(entry) ?? nativeKeyNotSent(entry);
}

/** The shared per-kind variables, in the order they are read. */
const SHARED_OPENAI_KEY_VARS = [
  "OPENAI_COMPAT_API_KEY",
  "OPENAI_API_KEY",
  "ATOMIC_AGENT_OPENAI_API_KEY",
] as const;

/**
 * The shared OpenAI-compatible key and the variable it came from, read
 * with `??` semantics: the first variable that is set wins, even empty
 * (an empty one means "no key").
 */
function sharedOpenAiKey(): { readonly name: string; readonly value: string } | undefined {
  for (const name of SHARED_OPENAI_KEY_VARS) {
    const value = process.env[name];
    if (value === undefined) continue;
    return value.length > 0 ? { name, value } : undefined;
  }
  return undefined;
}

const OPENAI_ORIGIN = "https://api.openai.com";

const NATIVE_KEY_DEFAULTS = new Map([
  ["aimlapi", { origin: DEFAULT_AIMLAPI_BASE, name: "AIMLAPI_API_KEY" }],
  ["anthropic", { origin: "https://api.anthropic.com", name: "ANTHROPIC_API_KEY" }],
  ["gemini", { origin: "https://generativelanguage.googleapis.com", name: "GEMINI_API_KEY" }],
  ["openrouter", { origin: "https://openrouter.ai", name: "OPENROUTER_API_KEY" }],
]);

const NATIVE_KEY_DESTINATIONS = new Map(
  [...NATIVE_KEY_DEFAULTS]
    .map(([kind, { name, origin }]) => [name, { kind, origin }] as const),
);

/** The variables that usually hold the operator's real OpenAI key (ATO-1703). */
export const OPENAI_KEY_VARIABLES: ReadonlySet<string> = new Set([
  "OPENAI_API_KEY",
  "ATOMIC_AGENT_OPENAI_API_KEY",
]);

/** Why a reserved variable was withheld, without its value. */
export function describeProviderKeyDestination(name: string): string | null {
  const canonical = name.toUpperCase();
  if (OPENAI_KEY_VARIABLES.has(canonical)) {
    return `${name} is not sent to this server. OpenAI keys go only to api.openai.com or loopback.`;
  }
  const native = NATIVE_KEY_DESTINATIONS.get(canonical);
  return native ? `${name} is not sent to this server. ${name} is reserved for ${native.origin} or loopback.` : null;
}

/**
 * ATO-1703: whether `OPENAI_API_KEY` / `ATOMIC_AGENT_OPENAI_API_KEY` may be
 * sent to a compat entry's `baseUrl`. Only OpenAI's own API and this
 * machine qualify. Reserved keys accept localhost (with an optional root
 * dot), 127/8, ::1 and IPv4-mapped 127/8. No `baseUrl` answers `true`: the
 * compat providers refuse to start without one, so nothing is sent, and
 * callers that look a key up before the address is known keep working.
 * Anything unparsable gets nothing.
 */
export function mayReceiveOpenAiKey(baseUrl: string | undefined): boolean {
  return mayReceiveDefaultKey(baseUrl, OPENAI_ORIGIN);
}

function mayReceiveDefaultKey(baseUrl: string | undefined, officialOrigin: string): boolean {
  if (baseUrl === undefined || baseUrl.length === 0) return true;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.origin === officialOrigin) return true;
  const host = classifiableHostOf(baseUrl);
  if (host === "localhost" || host === "::1") return true;
  if (host === null || !/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return false;
  // The general host classifier also unwraps routed IPv6 prefixes.
  return !url.hostname.startsWith("[") || /^\[::ffff:[0-9a-f]+:[0-9a-f]+\]$/i.test(url.hostname);
}

/**
 * Reserved vendor variable names belong to the vendor's API or loopback.
 * With no explicit URL, a native kind supplies its own default origin.
 */
function mayUseKeyVariable(
  entry: { readonly kind?: string; readonly baseUrl?: string },
  name: string,
): boolean {
  const canonical = name.toUpperCase();
  const native = NATIVE_KEY_DESTINATIONS.get(canonical);
  if (native !== undefined) {
    return entry.baseUrl
      ? mayReceiveDefaultKey(entry.baseUrl, native.origin)
      : entry.kind === native.kind;
  }
  if (!OPENAI_KEY_VARIABLES.has(canonical)) return true;
  if (entry.baseUrl !== undefined && entry.baseUrl.length > 0) {
    return mayReceiveOpenAiKey(entry.baseUrl);
  }
  return (
    entry.kind === undefined ||
    entry.kind === "openai-compatible" ||
    entry.kind === "qwen-openai-compatible"
  );
}

/** Whether an explicitly selected environment key may be sent to an HTTP endpoint. */
export function maySendApiKeyVariableToUrl(name: string, baseUrl: string): boolean {
  return mayUseKeyVariable({ baseUrl }, name);
}

/**
 * Whether the shared OPENAI_* key may go to `baseUrl`. Those variables
 * usually hold the operator's real OpenAI key, so it goes only where it
 * cannot be read on the way or by the wrong party: an https:// endpoint
 * (the default endpoint, when no `baseUrl` is set, is https) or plain
 * http:// to this machine. Plain http:// to any other host (a public IP,
 * a box on the LAN) and a server on another computer on the network, over
 * either scheme (ATO-1066), get no shared key; an entry that wants one
 * there sets `apiKey` or `apiKeyEnvVar`. Wildcard DNS names without a
 * readable address also need an explicit key.
 */
export function maySendSharedOpenAiKey(baseUrl: string | undefined): boolean {
  if (baseUrl === undefined || baseUrl.trim().length === 0) return true;
  if (isOtherComputerOnNetworkUrl(baseUrl) || hasUnresolvedWildcardDnsAddress(baseUrl)) return false;
  let protocol: string;
  try {
    protocol = new URL(baseUrl).protocol;
  } catch {
    return false;
  }
  if (protocol === "https:") return true;
  return protocol === "http:" && isLoopbackUrl(baseUrl);
}

/**
 * The values of an entry's `extraApiKeyEnvVars` (ATO-471), read the way
 * `apiKeyEnvVar` is: from `process.env`, which bootstrap fills from
 * `<stateDir>/.env`. config.json holds only the names. Unset or blank
 * variables are skipped; order is kept, repeats are dropped.
 */
export function resolveExtraApiKeys(
  entry: {
    readonly extraApiKeyEnvVars?: readonly string[];
    readonly kind?: string;
    readonly baseUrl?: string;
  },
  env: NodeJS.ProcessEnv = process.env,
  options: {
    /**
     * Despite the historical name, `false` reads every reserved variable
     * for callers that only mask values in output and never send them.
     */
    readonly scopeOpenAiKey?: boolean;
  } = {},
): string[] {
  const out: string[] = [];
  const names = entry.extraApiKeyEnvVars;
  // Defensive: a hand-edited runtime entry may carry a non-array here.
  if (!Array.isArray(names)) return out;
  for (const name of names) {
    if (typeof name !== "string" || name.length === 0) continue;
    // ATO-1703: the same rule as `apiKeyEnvVar`.
    if (options.scopeOpenAiKey !== false && !mayUseKeyVariable(entry, name)) {
      continue;
    }
    const key = env[name]?.trim();
    if (key && key.length > 0 && !out.includes(key)) out.push(key);
  }
  return out;
}
