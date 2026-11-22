import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { offlineRefusal } from "../../llm/offline-network.js";
import { assertHostAllowed, parseHttpUrl, type HostLookup } from "../os/web/web-fetch-ssrf-guard.js";
import type { ArtifactOutcome } from "./artifact-process.js";
import { MAX_RESEARCH_LINKS, type ResearchLink, type ResearchLinkVerdict } from "./research-check.js";

const PROXY_KEYS = new Set(["http_proxy", "https_proxy", "all_proxy", "npm_config_proxy", "npm_config_https_proxy", "npm_config_http_proxy"]);
const MAX_DNS_LOOKUPS = 4;
const MAX_REDIRECTS = 3;
let activeLookups = 0;

type Verdict = Pick<ResearchLinkVerdict, "status" | "reason">;
export type ResearchProbe = (url: string, signal: AbortSignal) => Promise<Verdict>;
export type ResearchApproval = (links: readonly ResearchLink[]) => Promise<string | undefined>;

function requestHeaders(url: URL, ip: string, method: "HEAD" | "GET", signal: AbortSignal): Promise<{ status: number; location?: string }> {
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method, signal, agent: false, family: isIP(ip),
      lookup: (_host, _options, callback) => callback(null, ip, isIP(ip)),
      headers: { "User-Agent": "Atomic-Agent-Research/1.0", ...(method === "GET" ? { Range: "bytes=0-0" } : {}) },
    }, response => {
      const { statusCode, headers } = response;
      response.destroy();
      resolve({ status: statusCode ?? 0, location: headers.location });
    });
    req.once("error", reject);
    req.end();
  });
}

interface ProbeDeps {
  lookup?: HostLookup;
  request?: typeof requestHeaders;
  env?: NodeJS.ProcessEnv;
  allowUrl?: (url: string) => boolean;
}

async function requestPinned(url: URL, ips: readonly string[], request: typeof requestHeaders, signal: AbortSignal) {
  for (const ip of ips) {
    signal.throwIfAborted();
    const attempt = ips.length === 1 ? signal : AbortSignal.any([signal, AbortSignal.timeout(500)]);
    try {
      const head = await request(url, ip, "HEAD", attempt);
      if (![404, 405, 410, 501].includes(head.status)) return head;
      return await request(url, ip, "GET", attempt);
    } catch {
      signal.throwIfAborted();
    }
  }
  throw new Error("no pinned address answered");
}

export async function probeResearchLink(raw: string, signal: AbortSignal, deps: ProbeDeps = {}): Promise<Verdict> {
  if (Object.entries(deps.env ?? process.env).some(([key, value]) => value?.trim() && PROXY_KEYS.has(key.toLowerCase()))) {
    return { status: "unverified", reason: "proxy configured and pinned proxy transport unavailable" };
  }
  try {
    let url = parseHttpUrl(raw);
    const request = deps.request ?? requestHeaders;
    const resolveHost = deps.lookup ?? (host => dnsLookup(host, { all: true }));
    const lookup: HostLookup = async host => {
      signal.throwIfAborted();
      if (activeLookups >= MAX_DNS_LOOKUPS) throw new Error("DNS lookup capacity exhausted");
      activeLookups += 1;
      try { return await resolveHost(host); }
      finally { activeLookups -= 1; }
    };
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      signal.throwIfAborted();
      if (url.username || url.password || deps.allowUrl?.(url.href) === false) return { status: "unverified", reason: "URL contains credentials or a hidden value" };
      if (offlineRefusal(url, "verify.run research")) return { status: "unverified", reason: "runtime is offline" };
      const addresses = await assertHostAllowed(url, { lookup });
      const { status, location } = await requestPinned(url, [...new Set(addresses)], request, signal);
      if (status === 404 || status === 410) return { status: "missing", reason: "HTTP " + status + " confirmed by GET" };
      if (status >= 200 && status < 300) return { status: "verified", reason: "HTTP " + status };
      if (![301, 302, 303, 307, 308].includes(status) || !location) return { status: "unverified", reason: "HTTP " + status };
      if (redirects === MAX_REDIRECTS) break;
      url = parseHttpUrl(new URL(location, url).href);
    }
    return { status: "unverified", reason: "redirect limit exceeded" };
  } catch {
    // getaddrinfo ENOTFOUND also covers non-authoritative resolver failures.
    return { status: "unverified", reason: signal.aborted ? "probe cancelled or timed out" : "connection, DNS or address check failed" };
  }
}

function boundedProbe(probe: ResearchProbe, url: string, signal: AbortSignal): Promise<Verdict> {
  if (signal.aborted) return Promise.resolve({ status: "unverified", reason: "probe cancelled or timed out" });
  return new Promise((resolve, reject) => {
    const abort = () => resolve({ status: "unverified", reason: "probe cancelled or timed out" });
    signal.addEventListener("abort", abort, { once: true });
    probe(url, signal).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function checkResearchLinks(out: ArtifactOutcome, probe?: ResearchProbe, timeoutMs = 15_000, signal?: AbortSignal, reason = "network disabled or approval unavailable"): Promise<ArtifactOutcome> {
  const { links, linkLimit, ...local } = out;
  if (!links?.length) return local;
  const overLimit = linkLimit === true || links.length > MAX_RESEARCH_LINKS;
  const timeout = AbortSignal.timeout(Math.min(15_000, Math.max(1, Math.floor(timeoutMs))));
  const deadline = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  const researchLinks: ResearchLinkVerdict[] = [];
  let status = local.status;
  for (const { url, citations, ambiguous } of links.slice(0, MAX_RESEARCH_LINKS)) {
    const linkTimeout = AbortSignal.any([deadline, AbortSignal.timeout(2_000)]);
    const result: Verdict = ambiguous ? { status: "unverified", reason: "ambiguous URL punctuation" }
      : overLimit || probe === undefined
      ? { status: "unverified", reason: overLimit ? "URL limit exceeded" : reason }
      : await boundedProbe(probe, url, linkTimeout);
    if (result.status === "missing") status = "fail";
    else if (result.status === "unverified" && status === "pass") status = "uncheckable";
    researchLinks.push({ citations, url, ...result });
  }
  // Keep broken links visible before the informational and warning lines.
  const line = (link: ResearchLinkVerdict) => `${link.citations} ${link.url} — ${link.status} (${link.reason})`;
  const missing = researchLinks.filter(link => link.status === "missing");
  const others = researchLinks.filter(link => link.status !== "missing");
  return { ...local, status, researchLinks, detail: [...missing.map(line), local.detail, ...others.map(line)].join("\n") };
}
