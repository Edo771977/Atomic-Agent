import { activePolicy } from "../../policy/policy-active.js";
import { policyCallAsks, policyCallRefusal } from "../../policy/policy-enforce.js";
import {
  compressToolResult,
  type CompressedToolResult,
} from "../../compressor/result-compressor.js";
import {
  requireApproval,
  type DangerousToolOptions,
} from "../../approval/dangerous-tool.js";
import type { ToolContext } from "../tool-registry.js";
import { invalidLocalFileUrlReason } from "../read-scope/read-scope-targets.js";
import { requireUserSite } from "./user-profile-sites.js";
import {
  localPageMessage,
  localPageRefusal,
  type LocalPageRead,
} from "./gate-page-read.js";
import type { BrowserBackend, BrowserRedirectGuard } from "./browser-backend.js";
import {
  blockedDomainMessage,
  checkBrowserUrl,
  type BrowserDomainPolicy,
} from "./browser-domain-policy.js";
import {
  checkUrlSend,
  DEFAULT_URL_DATA_GUARD,
  noteUrlSendAllowed,
  urlSendGrantKey,
  urlSendReason,
} from "../os/web/url-data-guard.js";
import { maskUrlSecrets } from "../os/web/http-request-preview.js";
import {
  isOfflineNetwork,
  offlineRefusal,
  type OfflineNetworkError,
} from "../../llm/offline-network.js";

/** Schemes that never leave the machine; anything else is checked by host. */
const LOCAL_SCHEMES = new Set(["about:", "file:", "data:", "blob:"]);

/**
 * Offline mode (ATO-1084): the refusal for opening `url`, or `null`.
 * http(s) / ws(s) URLs pass only on this machine; `about:`, `file:`,
 * `data:` and `blob:` pass; any other scheme is refused while offline,
 * since the agent cannot tell what Chrome would fetch for it.
 */
export function offlineBrowserRefusal(
  tool: string,
  url: string,
): OfflineNetworkError | null {
  if (!isOfflineNetwork()) return null;
  let protocol: string;
  try {
    protocol = new URL(url.trim()).protocol.toLowerCase();
  } catch {
    return offlineRefusal(url, tool);
  }
  if (LOCAL_SCHEMES.has(protocol)) return null;
  return offlineRefusal(url.trim(), tool);
}

function offlineToolError(
  tool: string,
  url: string,
  refused: OfflineNetworkError,
  suffix = "",
): CompressedToolResult {
  return compressToolResult({
    tool,
    status: "error",
    output: `${refused.message}${suffix}`,
    details: { url, host: refused.host, reason: "offline_mode" },
  });
}

/** http(s) or `about:blank`: all the user's own Chrome may be sent to. */
export function isUserProfileUrl(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed.toLowerCase() === "about:blank") return true;
  try {
    const protocol = new URL(trimmed).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Domain-list gate for anything that opens a URL (`browser.navigate`,
 * `browser.tabs` new, `browser.search`). A blocked host comes back as a
 * tool error at every approval level; a host outside a non-empty
 * allow-list asks as `browser_offsite`. In the user's own Chrome
 * (`policy.userProfile`) a non-web URL is refused as a tool error and a
 * site not yet opened this session asks (`user-profile-sites.ts`). `null`
 * means "go ahead" (the caller still applies its own `browser_nonweb` gate).
 */
export async function gateBrowserUrl(
  dangerous: DangerousToolOptions,
  policy: BrowserDomainPolicy,
  tool: string,
  url: string,
  ctx: Pick<ToolContext, "sessionId" | "signal">,
): Promise<CompressedToolResult | null> {
  const offline = offlineBrowserRefusal(tool, url);
  if (offline) return offlineToolError(tool, url, offline);
  const org = policyCallRefusal(activePolicy(), "os.web.fetch", { url });
  if (org !== null) return compressToolResult({ tool, status: "error", output: org, details: { reason: "organization_policy" } });
  if (policyCallAsks(activePolicy(), "os.web.fetch", { url })) {
    await requireApproval({ ...dangerous, approvalRequired: true }, { sessionId: ctx.sessionId, tool, category: "http", reason: "Organization policy requires a decision for this destination", affectedResources: [url] }, ctx.signal, true);
  }
  if (policy.userProfile && !isUserProfileUrl(url)) {
    const destination = /^file:/i.test(url) ? "destination is a local file" : /^chrome:/i.test(url) ? "destination is a Chrome internal page" : "destination is not an http(s) page";
    return compressToolResult({
      tool,
      status: "error",
      output: `${tool}: this ${destination}, which the agent cannot open in your own Chrome. Choose an http(s) page; local files, saved passwords, settings and history are off limits.`,
      details: { url, reason: "user_profile_nonweb" },
    });
  }
  const invalidLocal = invalidLocalFileUrlReason(url);
  if (invalidLocal !== null) {
    return compressToolResult({
      tool,
      status: "error",
      output: localPageMessage(tool, url, invalidLocal),
      details: { url, path: url, reason: "local_file_refused" },
    });
  }
  const verdict = checkBrowserUrl(url, policy);
  if (verdict.kind === "blocked") {
    return compressToolResult({
      tool,
      status: "error",
      output: blockedDomainMessage(tool, verdict.host),
      details: { url, host: verdict.host, reason: "blocked_domain" },
    });
  }
  if (policy.userProfile) {
    // The user's own Chrome: a new site asks once per session (stricter
    // than `browser_offsite`, which it replaces here).
    await requireUserSite(dangerous, policy, tool, verdict.host, url, ctx);
    // ATO-1377: a cleared site still asks for an address full of data.
    // `"strict"`'s once-per-site rule is what `requireUserSite` just did.
    await requireUrlData(dangerous, policy, tool, url, ctx, "data");
    return null;
  }
  if (verdict.kind === "offsite") {
    await requireApproval(
      dangerous,
      {
        sessionId: ctx.sessionId,
        tool,
        category: "browser_offsite",
        reason: `${verdict.host} is not in browser.allowedDomains`,
        preview: url,
        affectedResources: [verdict.host],
      },
      ctx.signal,
    );
  }
  await requireUrlData(dangerous, policy, tool, url, ctx);
  return null;
}

/** Reuse the dispatch decision for a destination before Chrome follows the redirect. */
export function browserRedirectGuard(
  dangerous: DangerousToolOptions,
  policy: BrowserDomainPolicy,
  tool: string,
  ctx: Pick<ToolContext, "sessionId" | "signal">,
): BrowserRedirectGuard {
  return {
    signal: ctx.signal,
    async authorize(url, signal) {
      const refused = await gateBrowserUrl(dangerous, policy, tool, url, { sessionId: ctx.sessionId, signal });
      if (refused) throw new Error(refused.summary);
    },
  };
}

/**
 * Ask as `http_write` when `checkUrlSend` says `url` must ask first
 * (`url-data-guard.ts`). `modeCap` lowers `"strict"` to `"data"` where
 * sites are already asked about another way.
 */
async function requireUrlData(
  dangerous: DangerousToolOptions,
  policy: BrowserDomainPolicy,
  tool: string,
  url: string,
  ctx: Pick<ToolContext, "sessionId" | "signal">,
  modeCap?: "data",
): Promise<void> {
  const configured = policy.urlDataGuard ?? DEFAULT_URL_DATA_GUARD;
  const mode = modeCap !== undefined && configured === "strict" ? modeCap : configured;
  const check = checkUrlSend(mode, url, ctx.sessionId, policy.urlSendSites);
  if (check === null) return;
  const shown = maskUrlSecrets(url.trim());
  await requireApproval(
    dangerous,
    {
      sessionId: ctx.sessionId,
      tool,
      category: "http_write",
      reason: urlSendReason(shown, check),
      preview: shown,
      affectedResources: [check.host],
      grantKey: urlSendGrantKey(check),
    },
    ctx.signal,
  );
  noteUrlSendAllowed(check, ctx.sessionId, policy.urlSendSites);
}

/**
 * After an action that can move the browser (navigate, tabs new, a
 * click, Enter, a search), re-check where it landed: a redirect or a
 * link can end on a blocked host even when the URL asked for was fine.
 * On a blocked host the tab is sent to `about:blank` (so nothing from it
 * reaches the next snapshot) and a `blocked_domain` tool error comes
 * back; otherwise `null`. Best effort: a click that starts a navigation
 * later than the click itself returns is caught by the next read
 * (`browser.read_aria`), which refuses a blocked page too.
 *
 * With `local` and `policy.localPages`, a landed `file://` page is
 * checked like a read too: a meta refresh to `file:///…/.env`, or a click
 * on a `file://` listing's parent link, ends on a file nobody was asked
 * about. Such a page is cleared and refused the same way (never asked
 * about mid-action; the question belongs to a navigation naming it).
 *
 * Even without a domain/read-scope policy, an unmappable local URL is
 * refused: its filesystem target cannot be checked safely.
 *
 * While offline, a landed off-machine page is cleared and refused first.
 */
export async function recheckLandedPage(
  backend: Pick<BrowserBackend, "currentUrl" | "navigate">,
  policy: BrowserDomainPolicy,
  tool: string,
  landedUrl?: string,
  local?: LocalPageRead,
): Promise<CompressedToolResult | null> {
  const offline = isOfflineNetwork();
  let url = landedUrl;
  if (url === undefined) {
    try {
      url = await backend.currentUrl();
    } catch {
      return null;
    }
  }
  // ATO-1084: a link or redirect that left this machine while offline.
  const refused = offline ? offlineBrowserRefusal(tool, url) : null;
  if (refused) {
    await backend.navigate({ url: "about:blank" }).catch(() => undefined);
    return offlineToolError(tool, url, refused, " The action ended on that site, so the tab was cleared.");
  }
  const org = policyCallRefusal(activePolicy(), "os.web.fetch", { url });
  if (org !== null) {
    await backend.navigate({ url: "about:blank" }).catch(() => undefined);
    return compressToolResult({ tool, status: "error", output: org, details: { reason: "organization_policy" } });
  }
  const localFile = localPageRefusal([url], policy, local);
  if (localFile !== null) {
    await backend.navigate({ url: "about:blank" }).catch(() => undefined);
    return compressToolResult({
      tool,
      status: "error",
      output: `${localPageMessage(tool, localFile.path, localFile.why)} The action ended on that file, so the tab was cleared.`,
      details: { url, path: localFile.path, reason: "local_file_refused" },
    });
  }
  const verdict = checkBrowserUrl(url, policy);
  if (verdict.kind !== "blocked") return null;
  await backend.navigate({ url: "about:blank" }).catch(() => undefined);
  return compressToolResult({
    tool,
    status: "error",
    output: `${blockedDomainMessage(tool, verdict.host)} The action ended on that site, so the tab was cleared.`,
    details: { url, host: verdict.host, reason: "blocked_domain" },
  });
}
