import { afterEach, describe, expect, it, vi } from "vitest";
import { installPolicy } from "../../../policy/policy-active.js";
import { buildOsWebFetchTool, fetchRawPage } from "./web-fetch.js";
import { buildOsWebCrawlTool } from "./web-crawl.js";
import { buildOsHttpRequestTool } from "./http-request.js";
import * as transport from "./http-request-fetch.js";
import { USER_CONFIG_DEFAULTS, type WebCrawlConfig } from "../../../config/index.js";
import { ApprovalGate } from "../../../approval/approval-gate.js";
import type { runCommand } from "../../../sandbox/command-runner.js";

const origin = "https://fixture.test";
const restricted = `${origin}/restricted`;
const ctx = { workingDir: process.cwd(), sessionId: "fixture", stepIndex: 0, signal: new AbortController().signal };
const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
function setup() {
  installPolicy({ sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "webfetch", resource: `${restricted}*`, effect: "deny" }] });
}
function fakeSite(redirect: boolean) {
  const requests: string[] = [];
  const run: typeof runCommand = async (_cmd, args) => {
    const url = args.at(-1)!; requests.push(url);
    const next = redirect && url === `${origin}/` ? restricted : "";
    const body = url.endsWith("robots.txt") ? "" : `<html><body><p>Ordinary fixture page with a link.</p><a href="${restricted}">next</a></body></html>`;
    return { command: "fake-curl", args, exitCode: 0, signal: null, stdout: `${body}\n__ATOMIC_WEBFETCH_META__${next ? 302 : 200}|text/html|${next}|${body.length}|`, stderr: "", durationMs: 0, timedOut: false, truncated: false, inputTruncated: false };
  };
  return { requests, run };
}
afterEach(() => { installPolicy(null); vi.restoreAllMocks(); });
describe("organization policy on every web destination", () => {
  it.each(["tool", "raw"])("refuses fetch redirects in %s mode without an approval adapter", async mode => {
    setup(); const site = fakeSite(true);
    if (mode === "tool") expect((await buildOsWebFetchTool({ runCommand: site.run, lookup }).run({ url: `${origin}/` }, ctx)).status).toBe("error");
    else await expect(fetchRawPage(`${origin}/`, { cwd: ctx.workingDir, signal: ctx.signal, runCommand: site.run, lookup })).rejects.toThrow(/policy/);
    expect(site.requests).toEqual([`${origin}/`]);
  });
  it("checks HTTP redirect policy even when HTTP prompts are disabled", async () => {
    setup(); let continued = false;
    vi.spyOn(transport, "executeGuardedHttpRequest").mockImplementation(async (_url, _args, deps) => {
      await deps.authorizeRedirect?.(new URL(restricted)); continued = true;
      return {} as never;
    });
    const tool = buildOsHttpRequestTool({ approvals: new ApprovalGate({ level: 5, emit: () => undefined }), approvalRequired: false,
      config: { http: { ...USER_CONFIG_DEFAULTS.http, enabled: true, approvalMode: "never" } } });
    await tool.run({ url: `${origin}/` }, ctx).catch(() => undefined);
    expect(continued).toBe(false);
  });
  it("checks each crawl link through the raw-page transport", async () => {
    setup(); const site = fakeSite(false);
    const tool = buildOsWebCrawlTool({ runCommand: site.run, lookup, sleep: async () => undefined,
      config: { web: { ...USER_CONFIG_DEFAULTS.web, crawl: { ...(USER_CONFIG_DEFAULTS.web.crawl as WebCrawlConfig), minDelayMs: 0 } } } });
    await tool.run({ url: `${origin}/`, maxDepth: 1, maxPages: 3, useSitemap: false }, ctx);
    expect(site.requests).toContain(`${origin}/`); expect(site.requests).not.toContain(restricted);
  });
  it("rechecks cached crawl pages against the current policy", async () => {
    installPolicy({ rules: [], sources: [], mcpAllowlists: [] }); const site = fakeSite(false);
    const tool = buildOsWebCrawlTool({ runCommand: site.run, lookup, sleep: async () => undefined,
      config: { web: { ...USER_CONFIG_DEFAULTS.web, crawl: { ...(USER_CONFIG_DEFAULTS.web.crawl as WebCrawlConfig), minDelayMs: 0 } } } });
    const args = { url: `${origin}/`, maxDepth: 1, maxPages: 3, useSitemap: false };
    await tool.run(args, ctx); setup();
    const result = await tool.run(args, ctx);
    expect((result.details?.pages as Array<{ url: string }>).map(page => page.url)).not.toContain(restricted);
  });
});
