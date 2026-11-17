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
 * person's click (lan:allowFolderHost), and re-checks everything a warning
 * would have checked, so it can never add a host no warning offered.
 *
 * The address rules are copies of the agent's (`constraintHostOf` in
 * src/llm/provider/url-host.ts, `isLoopbackHost` in src/llm/offline-network.ts,
 * `normalizeProviderHost` in src/config/project-constraints-config.ts, and
 * local-server-url.ts); test/folder-provider-hosts.test.mjs compares them.
 */

import { isIP } from "node:net";

import { rewriteWholeConfig } from "./agent-cli.js";
import { isLocalServerUrl } from "./local-server-url.js";

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
  if (host === null || isLoopbackHost(host) || !isLocalServerUrl(url)) return null;
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
 * the file, as read in that hold, would warn for exactly this folder and
 * provider. Nothing else in the file is touched.
 */
export async function allowFolderProviderHost(folder: string, providerId: string, url: string): Promise<AllowHostResult> {
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
