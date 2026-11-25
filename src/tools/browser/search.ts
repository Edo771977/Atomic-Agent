import { activePolicy } from "../../policy/policy-active.js";
import { policyCallAsks, policyCallRefusal } from "../../policy/policy-enforce.js";
import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ToolDefinition } from "../tool-registry.js";
import type { BrowserBackend, SearchInput } from "./browser-backend.js";
import { captureWorldSnapshot } from "./capture-world-snapshot.js";
import type { AriaSnapshotStore } from "./aria-view.js";
import { requireApproval, type DangerousToolOptions } from "../../approval/dangerous-tool.js";
import {
  EMPTY_DOMAIN_POLICY,
  type BrowserDomainPolicy,
} from "./browser-domain-policy.js";
import { browserRedirectGuard, gateBrowserUrl, recheckLandedPage } from "./gate-browser-url.js";
import { searchUrlFor } from "./search-engines.js";
import { BROWSER_PAGE_SOURCE } from "../untrusted-tool-output.js";

/** The engine's host goes through the same domain lists as a navigation. */
export function buildBrowserSearchTool(
  backend: BrowserBackend,
  dangerous: DangerousToolOptions,
  policy: BrowserDomainPolicy = EMPTY_DOMAIN_POLICY,
  store?: AriaSnapshotStore,
): ToolDefinition {
  return {
    name: "browser.search",
    description:
      "Run a web search in the live browser: opens the engine's results page and refreshes the world snapshot. Engine defaults to google. Use only when the user explicitly asks to search via the browser, or when you then need to click/scroll/read the live results page.",
    readonly: false,
    // The results page is someone else's text, and it reaches `### world`.
    untrustedOutput: BROWSER_PAGE_SOURCE,
    async run(rawArgs, ctx) {
      const query = rawArgs.query;
      if (typeof query !== "string" || query.length === 0) {
        throw new Error("browser.search: `query` must be a non-empty string");
      }
      const org = policyCallRefusal(activePolicy(), "os.web.search", { query }, ctx.workingDir);
      if (org !== null) return compressToolResult({ tool: "browser.search", status: "error", output: org, details: { reason: "organization_policy" } });
      if (policyCallAsks(activePolicy(), "os.web.search", { query })) {
        await requireApproval({ ...dangerous, approvalRequired: true }, { sessionId: ctx.sessionId, tool: "browser.search", category: "http", reason: "Organization policy requires a decision for this search", affectedResources: [query] }, ctx.signal, true);
      }
      const engine = parseEngine(rawArgs.engine);
      const refused = await gateBrowserUrl(
        dangerous,
        policy,
        "browser.search",
        searchUrlFor(engine ?? "google", query),
        ctx,
      );
      if (refused) return refused;
      await backend.ensureReady();
      const payload: SearchInput = {
        query,
        redirectGuard: browserRedirectGuard(dangerous, policy, "browser.search", ctx),
        ...(engine !== undefined ? { engine } : {}),
      };
      const result = await backend.search(payload);
      const landed = await recheckLandedPage(backend, policy, "browser.search", undefined, {
        reader: ctx,
      });
      if (landed) return landed;
      const worldSnapshot = await captureWorldSnapshot(backend, ctx, policy, store);
      return compressToolResult({
        tool: "browser.search",
        status: "ok",
        output: `opened search results: ${result.url}`,
        details: {
          url: result.url,
          engine: engine ?? "google",
          ...(worldSnapshot ? { worldSnapshot } : {}),
        },
      });
    },
  };
}

function parseEngine(
  value: unknown,
): "google" | "duckduckgo" | "bing" | undefined {
  if (value === "google" || value === "duckduckgo" || value === "bing") {
    return value;
  }
  return undefined;
}
