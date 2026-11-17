/**
 * Issue #65 (core #60): a folder whose `projects.constraints[F].allowedProviders`
 * lists a local provider allows it on THIS computer only. Pointed at another
 * computer on the network ("Find on my network"), the agent refuses it there
 * at dispatch unless the folder lists that host in `allowedProviderHosts`
 * (src/llm/docs/provider-policy.md, `providerEndpointRefusal`).
 *
 * `folderHostWarnings` says so before the person saves the address, one line
 * per such folder, with an action; `allowFolderProviderHost` is that action:
 * it adds the host, in the agent's one spelling, to that folder's list
 * through the whole-file compare-and-swap write. It runs only on the
 * person's click (lan:allowFolderHost) and re-checks, on the file it writes,
 * what the warning checked, for the provider the field's address feeds.
 *
 * The address rules are copies of the agent's (`constraintHostOf` in
 * src/llm/provider/url-host.ts, `isLoopbackHost` in src/llm/offline-network.ts,
 * `normalizeProviderHost` in src/config/project-constraints-config.ts, and
 * `isPrivateNetworkUrl` below for `isLocalServerUrl`); test/folder-provider-hosts.test.mjs
 * compares them.
 */

import { isIP } from "node:net";

import { rewriteWholeConfig } from "./agent-cli.js";

/** src/llm/provider/url-host.ts constraintHostOf. */
export function constraintHostOf(url: string | undefined): string | null {
  if (!url) return null;
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return null;
  }
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host.length === 0) return null;
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped === null) return host;
  const high = parseInt(mapped[1]!, 16);
  const low = parseInt(mapped[2]!, 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/** src/llm/offline-network.ts isLoopbackHost: this machine by literal address only. */
export function isLoopbackHost(host: string): boolean {
  let h = host.trim().toLowerCase().replace(/\.+$/, "");
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h === "localhost") return true;
  const family = isIP(h);
  if (family === 4) return h.startsWith("127.");
  if (family !== 6) return false;
  let v6: string;
  try {
    v6 = new URL(`http://[${h}]/`).hostname.slice(1, -1);
  } catch {
    return false;
  }
  return v6 === "::1" || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(v6);
}

/** src/config/project-constraints-config.ts normalizeProviderHost: a bare host in the list's spelling, or `null`. */
export function normalizeProviderHost(raw: string): string | null {
  const text = raw.trim();
  if (text.length === 0 || /[/*?#@\\\s]/.test(text)) return null;
  const bracketed = text.startsWith("[") ? text : text.includes(":") ? `[${text}]` : text;
  let url: URL;
  try {
    url = new URL(`http://${bracketed}`);
  } catch {
    return null;
  }
  if (url.port !== "" || url.pathname !== "/" || url.username !== "" || url.password !== "") return null;
  return constraintHostOf(url.href);
}

/**
 * The host a folder must list for a local provider at `url` to be reached
 * there: a private-network host that is not this machine by literal
 * address. `null` for this machine, a public host (the agent keeps the
 * id-only match) and a URL that cannot be read (nothing to offer).
 */
export function networkHostToList(url: string | undefined): string | null {
  const host = constraintHostOf(url);
  if (host === null || isLoopbackHost(host) || !isPrivateNetworkUrl(url)) return null;
  return host;
}

interface ProviderLike { id?: unknown; kind?: unknown; modelMode?: unknown }
interface ConstraintLike { allowedProviders?: unknown; allowedProviderHosts?: unknown }

function constraintsOf(cfg: unknown): Record<string, ConstraintLike> {
  const c = (cfg as { projects?: { constraints?: unknown } } | null)?.projects?.constraints;
  return c && typeof c === "object" && !Array.isArray(c) ? (c as Record<string, ConstraintLike>) : {};
}

/**
 * Whether the agent judges provider `id` by place (src/llm/provider-policy.ts
 * providerEndpointOf): a `llama-server`, or an OpenAI-compatible entry not
 * marked cloud. A private-network address is never a known cloud service,
 * so the base URL need not be read. An id with no entry yet is the
 * OpenAI-compatible provider the wizard is about to add.
 */
function judgedByPlace(cfg: unknown, id: string): boolean {
  const list = (cfg as { llm?: { providers?: unknown } } | null)?.llm?.providers;
  const entry = Array.isArray(list) ? (list as ProviderLike[]).find((p) => p && p.id === id) : undefined;
  if (!entry) return true;
  if (entry.kind === "llama-server") return true;
  if (entry.kind !== "openai-compatible" && entry.kind !== "qwen-openai-compatible") return false;
  return entry.modelMode !== "cloud";
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** renderer.js customProviderId: the id the wizard gives a custom provider at `url`. */
export function customProviderId(url: string): string {
  const body = String(url || "")
    .replace(/^https?:\/\//, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const id = ("custom-" + (body || "endpoint")).slice(0, 32).replace(/-+$/, "");
  return /^[a-z]/.test(id) ? id : "custom-endpoint";
}

/** Which address field the found server was put in, and the entry the wizard is editing (WIZ.forId). */
export interface LanField {
  fieldId: string;
  editingId?: string | null;
}

/**
 * The provider ids an address in `field` feeds once saved (the same as
 * renderer.js lanfProviderIdsFor):
 * - `llm-url` (localModels.url): `local-llama`, whose url the save rewrites
 *   (agent-cli setExternalLlamaUrl → syncLocalLlamaProviderUrl) even when it
 *   has one, and every other llama-server entry without its own url;
 * - `wiz-url` (a custom provider's Base URL): the OpenAI-compatible entry
 *   being edited, else the id the wizard derives from this address (as
 *   typed, or as a network row stores it: no trailing slash, no `/v1`).
 */
export function fieldProviderIds(cfg: unknown, field: LanField | undefined, url: string): string[] {
  const list = (cfg as { llm?: { providers?: unknown } } | null)?.llm?.providers;
  const providers = Array.isArray(list) ? (list as Array<ProviderLike & { url?: unknown }>).filter((p) => p && typeof p.id === "string") : [];
  if (field?.fieldId === "llm-url") {
    const ids = ["local-llama"];
    for (const p of providers) if (p.kind === "llama-server" && !p.url && !ids.includes(p.id as string)) ids.push(p.id as string);
    return ids;
  }
  if (field?.fieldId !== "wiz-url") return [];
  const editing = typeof field.editingId === "string" ? providers.find((p) => p.id === field.editingId) : undefined;
  if (editing && (editing.kind === "openai-compatible" || editing.kind === "qwen-openai-compatible")) return [editing.id as string];
  const ids = [customProviderId(url.trim())];
  try {
    const u = new URL(url.trim());
    const lanBase = u.protocol + "//" + u.host + u.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
    const lanId = customProviderId(lanBase);
    if (!ids.includes(lanId)) ids.push(lanId);
  } catch { /* the typed form only */ }
  return ids;
}

export interface FolderHostWarning {
  folder: string;
  providerId: string;
  host: string;
  text: string;
  action: string;
}

/**
 * One warning per folder that allows one of `providerIds` but would refuse
 * it at `url`: the first such id is named. Empty when `url` is this machine,
 * a public host or unreadable, or when no folder is concerned.
 */
export function folderHostWarnings(cfg: unknown, providerIds: readonly string[], url: string | undefined): FolderHostWarning[] {
  const host = networkHostToList(url);
  if (host === null) return [];
  const ids = providerIds.filter((id) => typeof id === "string" && judgedByPlace(cfg, id));
  const out: FolderHostWarning[] = [];
  for (const [folder, entry] of Object.entries(constraintsOf(cfg))) {
    if (!entry || typeof entry !== "object") continue;
    const allowed = strings(entry.allowedProviders);
    const providerId = ids.find((id) => allowed.includes(id));
    if (providerId === undefined) continue;
    const listed = strings(entry.allowedProviderHosts).map((h) => normalizeProviderHost(h));
    if (listed.includes(host)) continue;
    out.push({
      folder,
      providerId,
      host,
      text: `Folder ${folder} allows ${providerId} only on this computer; it will refuse ${host}`,
      action: `Allow ${host} for ${folder}`,
    });
  }
  return out;
}

export interface AllowHostResult {
  ok: boolean;
  changed: boolean;
  host?: string;
  error?: string;
}

/**
 * The warning's action: add the host of `url` to
 * `projects.constraints[folder].allowedProviderHosts`, read and written in
 * one hold of the config lock (agent-cli rewriteWholeConfig). Refused unless
 * the file, as read in that hold, would warn for this folder and provider
 * with `url` in `field`: the provider must be one that field feeds
 * (`fieldProviderIds`), judged by place, allowed by the folder, and the
 * host a network host the folder does not list yet. What it cannot check is
 * that the person will then save the address: a host listed for a field
 * left unsaved stays listed (and harmless until something points there).
 * Nothing else in the file is touched.
 */
export async function allowFolderProviderHost(folder: string, providerId: string, url: string, field: LanField | undefined): Promise<AllowHostResult> {
  if (typeof folder !== "string" || typeof providerId !== "string" || typeof url !== "string") {
    return { ok: false, changed: false, error: "folder, provider and address are required" };
  }
  const host = networkHostToList(url);
  if (host === null) return { ok: false, changed: false, error: "That address is not another computer on this network, so no folder needs it listed." };
  let refusal: string | null = null;
  let already = false;
  const res = await rewriteWholeConfig((cfg) => {
    refusal = null;
    already = false;
    const constraints = constraintsOf(cfg);
    if (!Object.prototype.hasOwnProperty.call(constraints, folder)) {
      refusal = `There is no folder constraint for ${folder}.`;
      return { write: false };
    }
    const entry = constraints[folder];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      refusal = `The constraint for ${folder} cannot be read.`;
      return { write: false };
    }
    if (!fieldProviderIds(cfg, field, url).includes(providerId)) {
      refusal = `The address in this field does not reach ${providerId}.`;
      return { write: false };
    }
    if (!strings(entry.allowedProviders).includes(providerId) || !judgedByPlace(cfg, providerId)) {
      refusal = `Folder ${folder} does not limit ${providerId} to this computer.`;
      return { write: false };
    }
    const current = entry.allowedProviderHosts;
    if (current !== undefined && !Array.isArray(current)) {
      refusal = `The allowedProviderHosts of ${folder} is not a list; fix it in config.json first.`;
      return { write: false };
    }
    const list = strings(current);
    if (list.some((h) => normalizeProviderHost(h) === host)) {
      already = true;
      return { write: false };
    }
    entry.allowedProviderHosts = [...(Array.isArray(current) ? current : []), host];
    return { write: true };
  });
  if (!res.ok) return { ok: false, changed: false, error: res.error };
  if (refusal !== null) return { ok: false, changed: false, error: refusal };
  return { ok: true, changed: !already && res.changed, host };
}

/**
 * The agent's `isLocalServerUrl` (src/llm/provider/openai/local-server-url.ts,
 * with `classifiableHostOf` from src/llm/provider/url-host.ts): this machine
 * or the local network, as the folder constraint judges a provider's
 * endpoint: loopback, RFC 1918, link-local, CGNAT/Tailscale 100.64/10, IPv6
 * unique- and link-local, own-network names (`.local`, `.lan`, `.internal`,
 * `.home.arpa`, `.home`, `.localdomain`, `.corp`, `.intranet`, `.ts.net`),
 * nip.io / sslip.io names by the address they spell, single-label hosts.
 * Used ONLY by the constraint warning. It is wider than local-server-url.ts on
 * purpose: that copy decides "cloud vs this machine" for project models and
 * must stay as the renderer's projectLocalUrl reads it.
 */
export function isPrivateNetworkUrl(url: string | undefined): boolean {
  const host = classifiableHostOf(url);
  if (host === null) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "0.0.0.0" || host === "::") return true;
  const v4 = host.split(".");
  if (v4.length === 4 && v4.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    const [a, b] = v4.map(Number) as [number, number];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) ||
      // Carrier-grade NAT, 100.64.0.0/10 (Tailscale).
      (a === 100 && b >= 64 && b <= 127);
  }
  if (host.includes(":")) return /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host);
  if (!host.includes(".")) return true;
  const wildcard = WILDCARD_DNS_SUFFIXES.find((suffix) => host.endsWith(suffix));
  if (wildcard) {
    const inside = wildcardDnsIpv4(host.slice(0, -wildcard.length));
    return inside === null || isPrivateNetworkUrl(`http://${inside}`);
  }
  return OWN_NETWORK_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

const OWN_NETWORK_SUFFIXES = [
  ".local", ".lan", ".internal", ".home.arpa", ".home", ".localdomain", ".corp", ".intranet", ".ts.net",
] as const;

const WILDCARD_DNS_SUFFIXES = [".nip.io", ".sslip.io"] as const;

/** The IPv4 address a nip.io / sslip.io name spells before its suffix, or `null`. */
function wildcardDnsIpv4(prefix: string): string | null {
  const labels = prefix.split(".");
  const dotted = labels.slice(-4);
  if (dotted.length === 4 && dotted.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    return dotted.join(".");
  }
  const last = labels[labels.length - 1] ?? "";
  const dashed = /(?:^|-)(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})$/.exec(last);
  if (dashed && dashed.slice(1).every((part) => Number(part) <= 255)) return dashed.slice(1).join(".");
  const hex = /(?:^|-)([0-9a-f]{8})$/.exec(last);
  if (hex) {
    const value = parseInt(hex[1]!, 16);
    return [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join(".");
  }
  return null;
}

/**
 * The host of a URL as the classifiers compare it: lower case, no IPv6
 * brackets, one trailing dot removed, and an IPv6 address that embeds an
 * IPv4 one replaced by that address. `null` when the URL does not parse
 * or has no host.
 */
function classifiableHostOf(url: string | undefined): string | null {
  if (!url) return null;
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return null;
  }
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host.length === 0) return null;
  return embeddedIpv4(host) ?? host;
}

/** IPv4-mapped, IPv4-translated, NAT64, IPv4-compatible and 6to4 forms → the IPv4 address inside, else `null`. */
function embeddedIpv4(host: string): string | null {
  const g = expandIpv6(host);
  if (g === null) return null;
  const zero = (from: number, to: number) => g.slice(from, to).every((part) => part === 0);
  const v4 = (high: number, low: number) => `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  if (zero(0, 5) && g[5] === 0xffff) return v4(g[6]!, g[7]!);
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return v4(g[6]!, g[7]!);
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return v4(g[6]!, g[7]!);
  if (zero(0, 6) && g[6] !== 0) return v4(g[6]!, g[7]!);
  if (g[0] === 0x2002) return v4(g[1]!, g[2]!);
  return null;
}

/** The eight 16-bit groups of an IPv6 address (a dotted IPv4 tail allowed), or `null`. */
function expandIpv6(host: string): number[] | null {
  if (!host.includes(":")) return null;
  let text = host;
  const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (tail) {
    const b = tail.slice(1).map(Number);
    if (b.some((part) => part > 255)) return null;
    text = `${text.slice(0, tail.index)}${((b[0]! << 8) | b[1]!).toString(16)}:${((b[2]! << 8) | b[3]!).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part.length === 0 ? [] : part.split(":"));
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...rest];
  if (!groups.every((part) => /^[0-9a-f]{1,4}$/.test(part))) return null;
  return groups.map((part) => parseInt(part, 16));
}
