import { posix, win32 } from "node:path";
import { classifiableHostOf } from "../llm/provider/url-host.js";
import { editDistance, emitConfigNoticeOnce } from "./config-primitives.js";
import { ConfigValidationError } from "./config-validation-error.js";
import type { ProjectConstraintsConfig } from "./tool-config.js";

export type { ProjectConstraintsConfig } from "./tool-config.js";

const FIELD = "projects.constraints";

/** The keys an entry may hold; anything else is warned about and ignored. */
export const CONSTRAINT_ENTRY_KEYS = ["allowedProviders", "allowedEgress", "allowedProviderHosts"] as const;

/**
 * The egress classes `allowedEgress` may name: what a tool in a
 * constrained folder may send off this machine (issue #33). Anything
 * else fails the load (closed), so a typo never opens a class.
 * `mcp:<server>` names one MCP server by its configured name (a remote one,
 * or a stdio one not marked `local: true`).
 */
export const EGRESS_CLASSES = ["web", "http", "browser", "github", "git", "channels", "mail", "composio", "serve"] as const;
export type EgressClass = (typeof EGRESS_CLASSES)[number] | `mcp:${string}`;

export function isEgressClass(value: string): value is EgressClass {
  if ((EGRESS_CLASSES as readonly string[]).includes(value)) return true;
  return value.startsWith("mcp:") && value.slice(4).trim().length > 0;
}

/** The known entry key `key` most likely means, or `null` when none is close. */
export function suggestConstraintEntryKey(key: string): string | null {
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const known of CONSTRAINT_ENTRY_KEYS) {
    const distance = editDistance(key.toLowerCase(), known.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = known;
    }
  }
  return best !== null && bestDistance <= Math.max(2, Math.floor(key.length / 4)) ? best : null;
}

function unknownEntryKeys(entry: Record<string, unknown>): string[] {
  return Object.keys(entry).filter((k) => !(CONSTRAINT_ENTRY_KEYS as readonly string[]).includes(k));
}

/**
 * Parse `projects.constraints` (config v80): `{ "<absolute folder>":
 * { allowedProviders: string[], allowedEgress?: string[],
 * allowedProviderHosts?: string[] } }`. Fail
 * closed: anything malformed — a non-object block or entry, a relative
 * or empty folder, a missing or non-list `allowedProviders`, an empty or
 * non-string id, an `allowedEgress` that is not a list of known classes
 * (`EGRESS_CLASSES`, `mcp:<server>`), an `allowedProviderHosts` entry that
 * is not a bare host (`normalizeProviderHost`) — is a `ConfigValidationError`, so a
 * typo can never quietly lift a constraint. An empty `allowedProviders`
 * is valid and means no provider may serve the folder; an absent or
 * empty `allowedEgress` means no tool may send content off the machine.
 *
 * Unknown keys inside an entry are dropped here and kept on disk by the
 * whole-file writer (`projects.constraints` is a dictionary branch,
 * `config-shape.ts`); `projectConstraintNotices` warns about each one,
 * with the closest known key. A misspelt `allowedProviders` still fails
 * closed: the list is then missing, and the error names the key that
 * was probably meant. The folder is kept as written; the matcher
 * normalises it. Whether a provider id names a configured provider is
 * checked by `projectConstraintNotices`, not here.
 */
export function parseProjectConstraints(
  raw: unknown,
  options: { platform?: NodeJS.Platform } = {},
): ProjectConstraintsConfig {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(FIELD, "expected an object of absolute folder → { allowedProviders }");
  }
  const isAbsolute = (options.platform ?? process.platform) === "win32" ? win32.isAbsolute : posix.isAbsolute;
  const out: ProjectConstraintsConfig = {};
  for (const [folder, entry] of Object.entries(raw as Record<string, unknown>)) {
    const field = `${FIELD}[${JSON.stringify(folder)}]`;
    if (folder.trim().length === 0 || !isAbsolute(folder)) {
      throw new ConfigValidationError(field, "the folder must be an absolute path");
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ConfigValidationError(field, "expected { allowedProviders: [...] }");
    }
    const list = (entry as { allowedProviders?: unknown }).allowedProviders;
    if (!Array.isArray(list)) {
      const typo = list === undefined
        ? unknownEntryKeys(entry as Record<string, unknown>).find((k) => suggestConstraintEntryKey(k) === "allowedProviders")
        : undefined;
      throw new ConfigValidationError(
        `${field}.allowedProviders`,
        typo === undefined
          ? "expected a list of provider ids"
          : `expected a list of provider ids; did you mean "allowedProviders" (got ${JSON.stringify(typo)})?`,
      );
    }
    const ids: string[] = [];
    for (const id of list) {
      if (typeof id !== "string" || id.trim().length === 0) {
        throw new ConfigValidationError(`${field}.allowedProviders`, "every provider id must be a non-empty string");
      }
      if (!ids.includes(id)) ids.push(id);
    }
    const egress = parseAllowedEgress((entry as { allowedEgress?: unknown }).allowedEgress, `${field}.allowedEgress`);
    const hosts = parseAllowedProviderHosts(
      (entry as { allowedProviderHosts?: unknown }).allowedProviderHosts,
      `${field}.allowedProviderHosts`,
    );
    out[folder] = {
      allowedProviders: ids,
      ...(egress === undefined ? {} : { allowedEgress: egress }),
      ...(hosts === undefined ? {} : { allowedProviderHosts: hosts }),
    };
  }
  return out;
}

function parseAllowedEgress(raw: unknown, field: string): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new ConfigValidationError(field, `expected a list of egress classes (${EGRESS_CLASSES.join(", ")}, mcp:<server>)`);
  }
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string" || !isEgressClass(value)) {
      throw new ConfigValidationError(
        field,
        `${JSON.stringify(value)} is not an egress class; expected one of ${EGRESS_CLASSES.join(", ")}, mcp:<server>`,
      );
    }
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

/**
 * The one spelling a host in `allowedProviderHosts` is kept and compared
 * in (issue #60): what `classifiableHostOf` makes of the host of a URL
 * (lower case, no brackets, no trailing dot, an IPv4-mapped IPv6 address
 * as its IPv4 address). `null` for anything that is not a bare host: a
 * URL, a port, a path, a wildcard, an empty string.
 */
export function normalizeProviderHost(raw: string): string | null {
  const text = raw.trim();
  if (text.length === 0 || /[/*?#@\\\s]/.test(text)) return null;
  // A bare IPv6 address has colons; anything else with one carries a port.
  const bracketed = text.startsWith("[") ? text : text.includes(":") ? `[${text}]` : text;
  let url: URL;
  try {
    url = new URL(`http://${bracketed}`);
  } catch {
    return null;
  }
  if (url.port !== "" || url.pathname !== "/" || url.username !== "" || url.password !== "") return null;
  return classifiableHostOf(url.href);
}

function parseAllowedProviderHosts(raw: unknown, field: string): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new ConfigValidationError(field, "expected a list of host names or IP addresses (no scheme, port or path)");
  }
  const out: string[] = [];
  for (const value of raw) {
    const host = typeof value === "string" ? normalizeProviderHost(value) : null;
    if (host === null) {
      throw new ConfigValidationError(
        field,
        `${JSON.stringify(value)} is not a host; expected a host name or IP address such as "192.168.1.20" or "gpu-box.lan" (no scheme, port, path or wildcard)`,
      );
    }
    if (!out.includes(host)) out.push(host);
  }
  return out;
}

/**
 * The warnings a valid `projects.constraints` block earns, one line
 * each (the block must already have passed `parseProjectConstraints`):
 *
 * - a key inside an entry this build does not know, which is ignored,
 *   with the closest known key when one is near;
 * - a provider id that names no configured provider. It is kept (a
 *   provider added later starts matching) but never matches anything
 *   until then. `openrouter` is always known: it is the id Core-proxied
 *   media is checked against.
 *
 * Pure, so `atomic-agent doctor` lists the same lines the load prints.
 */
export function projectConstraintNotices(
  raw: unknown,
  knownProviderIds: readonly string[],
): string[] {
  if (raw === undefined || raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
  const notices: string[] = [];
  for (const [folder, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const field = `${FIELD}[${JSON.stringify(folder)}]`;
    for (const key of unknownEntryKeys(entry as Record<string, unknown>)) {
      const near = suggestConstraintEntryKey(key);
      notices.push(`[atomic-agent] ${field} has unknown key ${JSON.stringify(key)} (ignored)` +
        (near === null ? "" : `; did you mean ${JSON.stringify(near)}?`));
    }
    const list = (entry as { allowedProviders?: unknown }).allowedProviders;
    for (const id of Array.isArray(list) ? list : []) {
      if (typeof id !== "string" || id === "openrouter" || knownProviderIds.includes(id)) continue;
      notices.push(`[atomic-agent] ${field} allows provider ${JSON.stringify(id)}, which is not configured; it matches nothing until a provider with that id is added`);
    }
  }
  return notices;
}

/** Emit `projectConstraintNotices` once each, through the config notice sink (stderr, or the TUI's screen). */
export function noteProjectConstraintNotices(raw: unknown, knownProviderIds: readonly string[]): void {
  for (const line of projectConstraintNotices(raw, knownProviderIds)) emitConfigNoticeOnce(line);
}
