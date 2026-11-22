import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { offlineRefusal } from "../../llm/offline-network.js";
import { assertHostAllowed, isBlockedIp, parseHttpUrl, type HostLookup } from "../os/web/web-fetch-ssrf-guard.js";
import type { ArtifactOutcome } from "./artifact-process.js";
import { MAX_RESEARCH_LINKS, type ResearchLink, type ResearchLinkVerdict } from "./research-check.js";

type Verdict = Pick<ResearchLinkVerdict, "status" | "reason">;
export type ResearchProbe = (url: string, signal: AbortSignal) => Promise<Verdict>;
export type ResearchApproval = (links: readonly ResearchLink[]) => Promise<string | undefined>;

function requestHeaders(url: URL, ip: string, method: "HEAD" | "GET", signal: AbortSignal): Promise<{ status: number; location?: string }> {
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method, signal, agent: false, family: isIP(ip),
      lookup: (_host, _options, callback) => callback(null, ip, isIP(ip)),
      headers: method === "GET" ? { Range: "bytes=0-0" } : {},
    }, response => {
      const { statusCode, headers } = response;
      response.destroy();
      resolve({ status: statusCode ?? 0, location: headers.location });
    });
    req.once("error", reject);
    req.end();
  });
}

export async function probeResearchLink(raw: string, signal: AbortSignal, deps: { lookup?: HostLookup; request?: typeof requestHeaders } = {}): Promise<Verdict> {
  let dnsMissing = false;
  try {
    const url = parseHttpUrl(raw);
    if (url.username || url.password) return { status: "unverified", reason: "URL contains credentials" };
    if (offlineRefusal(url, "verify.run research")) return { status: "unverified", reason: "runtime is offline" };
    const lookup = deps.lookup ?? (host => dnsLookup(host, { all: true }));
    const addresses = await assertHostAllowed(url, { lookup: async host => {
      try { return await lookup(host); }
      catch (error) {
        dnsMissing = (error as NodeJS.ErrnoException).code === "ENOTFOUND";
        throw error;
      }
    } });
    signal.throwIfAborted();
    const request = deps.request ?? requestHeaders;
    let response = await request(url, addresses[0]!, "HEAD", signal);
    if (response.status === 405 || response.status === 501) response = await request(url, addresses[0]!, "GET", signal);
    const { status, location } = response;
    if (status === 404 || status === 410) return { status: "missing", reason: `HTTP ${status}` };
    if (status >= 200 && status < 300) return { status: "verified", reason: `HTTP ${status}` };
    if (status >= 300 && status < 400 && location !== undefined) {
      const redirect = parseHttpUrl(new URL(location, url).href);
      if (isBlockedIp(redirect.hostname.replace(/^\[|\]$/gu, "")) || redirect.hostname.toLowerCase() === "localhost") {
        return { status: "unverified", reason: "redirect to a private/internal address refused" };
      }
      return { status: "unverified", reason: "redirect not followed" };
    }
    return { status: "unverified", reason: `HTTP ${status}` };
  } catch {
    return dnsMissing ? { status: "missing", reason: "domain does not resolve" }
      : { status: "unverified", reason: signal.aborted ? "probe cancelled or timed out" : "connection or address check failed" };
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
  for (const { url, citations } of links.slice(0, MAX_RESEARCH_LINKS)) {
    const linkTimeout = AbortSignal.any([deadline, AbortSignal.timeout(2_000)]);
    const result: Verdict = overLimit || probe === undefined
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
