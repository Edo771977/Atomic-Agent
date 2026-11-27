import { afterEach, describe, expect, it } from "vitest";
import { installPolicy } from "../../policy/policy-active.js";
import { GateBackend, facts, recordingGate, GATE_CTX } from "./browser-gate-test-helpers.js";
import { buildBrowserNavigateTool } from "./navigate.js";
import { buildBrowserTabsTool } from "./tabs.js";
import { buildBrowserSearchTool } from "./search.js";
import { buildBrowserClickTool } from "./click.js";
import { browserRedirectGuard, recheckLandedPage } from "./gate-browser-url.js";
import { gatePageRead } from "./gate-page-read.js";
import { ApprovalGate } from "../../approval/approval-gate.js";
const lists = { blockedDomains: [], allowedDomains: [] };
const url = "https://shop.example/restricted/page";
function policy(action: "webfetch" | "websearch" = "webfetch") {
  installPolicy({ sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action, resource: action === "webfetch" ? "https://shop.example/restricted/*" : "restricted topic", effect: "deny" }] });
}
afterEach(() => installPolicy(null));
describe("organization policy with empty browser domain lists", () => {
  it.each(["navigate", "tabs"])("%s refuses before backend use", async kind => {
    policy(); const backend = new GateBackend(); const { options } = recordingGate(true);
    const tool = kind === "navigate" ? buildBrowserNavigateTool(backend, options, lists) : buildBrowserTabsTool(backend, options, lists);
    expect((await tool.run({ url, action: "new" }, GATE_CTX)).status).toBe("error");
    expect(backend.navigations).toHaveLength(0); expect(backend.tabCalls).toBe(0);
  });
  it("search checks the query as websearch", async () => {
    policy("websearch"); const backend = new GateBackend(); const { options } = recordingGate(true);
    expect((await buildBrowserSearchTool(backend, options, lists).run({ query: "restricted topic" }, GATE_CTX)).status).toBe("error");
    expect(backend.searches).toBe(0);
  });
  it("click evaluates the full destination including its path", async () => {
    policy(); const backend = new GateBackend(); backend.element = facts({ href: url }); const { options } = recordingGate(true);
    expect((await buildBrowserClickTool(backend, options, lists).run({ ref: "e1" }, GATE_CTX)).status).toBe("error");
    expect(backend.clicks).toHaveLength(0);
  });
  it("redirect guards evaluate full destinations", async () => {
    policy(); const { options } = recordingGate(true);
    await expect(browserRedirectGuard(options, lists, "browser.navigate", GATE_CTX).authorize(url, GATE_CTX.signal)).rejects.toThrow(/policy/);
  });
  it("final destinations are refused and cleared before snapshots", async () => {
    policy(); const backend = new GateBackend(); backend.url = url;
    expect((await recheckLandedPage(backend, lists, "browser.click"))?.status).toBe("error");
    expect(backend.url).toBe("about:blank"); expect(backend.snapshots).toBe(0);
  });
  it("page and frame reads check policy before returning content", async () => {
    policy();
    await expect(gatePageRead({ url: "https://shop.example/", frameUrls: [url] }, lists, "fixture")).rejects.toThrow(/policy/);
  });
  it("ask prompts at full trust even for an embedder with approvals disabled", async () => {
    installPolicy({ sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "webfetch", resource: "https://shop.example/*", effect: "ask" }] });
    let prompts = 0;
    const gate = new ApprovalGate({ level: 5, emit: request => { prompts++; gate.resolve({ approvalId: request.approvalId, approved: false }); } });
    const backend = new GateBackend();
    await expect(buildBrowserNavigateTool(backend, { approvals: gate, approvalRequired: false }, lists).run({ url }, GATE_CTX)).rejects.toMatchObject({ name: "ApprovalDeniedError" });
    expect(prompts).toBe(1); expect(backend.navigations).toHaveLength(0);
  });
});
