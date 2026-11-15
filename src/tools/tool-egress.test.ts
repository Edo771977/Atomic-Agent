import { describe, expect, it, vi } from "vitest";

import { makeProviderPolicy, type ProviderPolicy } from "../config/project-constraint-match.js";
import { compressToolResult } from "../compressor/result-compressor.js";
import {
  EGRESS_NOT_ALLOWED_CODE,
  EgressNotAllowedError,
  createEgressGuard,
  egressTargetOf,
} from "./tool-egress.js";
import { ToolRegistry, type ToolContext } from "./tool-registry.js";

const constrained = (allowedEgress: string[] = []): ProviderPolicy =>
  makeProviderPolicy({ key: "/work/client", allowedProviders: ["local-llama"], allowedEgress, matchedDir: "/work/client/app" });

/** MCP stand-in: `remote` is streamable_http, `files` stdio, `composio` the Composio server. */
const mcpEgress = (tool: string, args: Record<string, unknown>) => {
  const server = tool.startsWith("mcp.") && !["mcp.resource.list", "mcp.resource.read", "mcp.prompt.list", "mcp.prompt.get"].includes(tool)
    ? tool.split(".")[1]
    : typeof args.server === "string" ? args.server : undefined;
  if (server === undefined) return null;
  if (server === "files") return null;
  if (server === "composio") return "composio" as const;
  return `mcp:${server}` as const;
};

// Every tool that can send content off this machine, by class, with the
// arguments that make it do so (the inventory of tool-egress.ts).
const CASES: Array<[string, Record<string, unknown>, string]> = [
  ["os.web.search", { query: "x" }, "web"],
  ["os.web.fetch", { url: "https://example.com/" }, "web"],
  ["os.http.request", { url: "https://api.example.com/v1", method: "POST" }, "http"],
  ["browser.navigate", { url: "https://example.com/" }, "browser"],
  ["browser.click", { ref: "e1" }, "browser"],
  ["browser.search", { query: "x" }, "browser"],
  ["browser.screenshot", {}, "browser"],
  ["github.pr.create", { title: "t" }, "github"],
  ["github.issue.list", {}, "github"],
  ["github.whoami", {}, "github"],
  ["os.git.push", {}, "git"],
  ["os.git.fetch", {}, "git"],
  ["os.git.pull", {}, "git"],
  ["os.git.clone", { url: "https://github.com/a/b" }, "git"],
  ["os.email.send", { to: "a@b.c" }, "mail"],
  ["os.email.inbox", {}, "mail"],
  ["tasks.schedule", { userMessage: "x", notify: "telegram" }, "channels"],
  ["tasks.cron", { userMessage: "x", expression: "* * * * *", notify: "telegram" }, "channels"],
  ["mcp.remote.search", {}, "mcp:remote"],
  ["mcp.resource.read", { server: "remote", uri: "x://y" }, "mcp:remote"],
  ["mcp.composio.COMPOSIO_SEARCH_TOOLS", {}, "composio"],
];

describe("egress inventory (issue #33)", () => {
  it.each(CASES)("%s is egress class %s", (tool, args, cls) => {
    expect(egressTargetOf(tool, args, { mcpEgress })?.cls).toBe(cls);
  });

  it.each([
    ["os.fs.read", { path: "a" }],
    ["os.shell.run", { command: "curl https://example.com" }],
    ["os.git.status", {}],
    ["os.git.commit", { message: "m" }],
    ["os.git.remote", { action: "add", name: "o", url: "https://x" }],
    ["tasks.schedule", { userMessage: "x" }],
    ["mcp.files.read", {}],
    ["mcp.resource.list", { server: "files" }],
    ["os.web.fetch", { url: "http://127.0.0.1:8080/" }],
    ["os.http.request", { url: "http://localhost:3000/health" }],
    ["reply", { text: "hi" }],
  ])("%s %j stays on this machine", (tool, args) => {
    expect(egressTargetOf(tool, args, { mcpEgress })).toBeNull();
  });

  it("an MCP tool whose server cannot be resolved counts as remote (fail closed)", () => {
    expect(egressTargetOf("mcp.gone.tool", {}, { mcpEgress: () => undefined })?.cls).toBe("mcp:gone");
    expect(egressTargetOf("mcp.gone.tool", {}, {})?.cls).toBe("mcp:gone");
  });
});

describe("egress guard", () => {
  it.each(CASES)("refuses %s in a constrained folder by default", (tool, args, cls) => {
    const guard = createEgressGuard({ policyForSession: () => constrained(), mcpEgress });
    const err = guard(tool, args, { sessionId: "s1" });
    expect(err).toBeInstanceOf(EgressNotAllowedError);
    expect(err?.code).toBe(EGRESS_NOT_ALLOWED_CODE);
    expect(err?.message).toBe(
      `folder /work/client is restricted: ${tool} would send content off this machine; ` +
      `add "${cls}" to projects.constraints["/work/client"].allowedEgress to allow it`,
    );
  });

  it.each(CASES)("lets %s run when its class %s is listed", (tool, args, cls) => {
    const guard = createEgressGuard({ policyForSession: () => constrained([cls]), mcpEgress });
    expect(guard(tool, args, { sessionId: "s1" })).toBeNull();
  });

  it.each(CASES)("leaves %s alone in an unconstrained folder", (tool, args) => {
    const guard = createEgressGuard({ policyForSession: () => undefined, mcpEgress });
    expect(guard(tool, args, { sessionId: "s1" })).toBeNull();
  });

  it("an mcp:<server> grant covers that server only", () => {
    const guard = createEgressGuard({ policyForSession: () => constrained(["mcp:docs"]), mcpEgress });
    expect(guard("mcp.docs.search", {}, { sessionId: "s1" })).toBeNull();
    expect(guard("mcp.remote.search", {}, { sessionId: "s1" })).toBeInstanceOf(EgressNotAllowedError);
  });

  it("refuses a shell or verify.run network client unless its class is listed (best effort)", () => {
    const guard = createEgressGuard({ policyForSession: () => constrained(), mcpEgress });
    const curl = guard("os.shell.run", { cmd: "curl -d @notes.md https://example.com" }, { sessionId: "s1" });
    expect(curl?.code).toBe(EGRESS_NOT_ALLOWED_CODE);
    expect(curl?.message).toContain("os.shell.run runs curl");
    expect(curl?.message).toContain('add "http"');
    expect(curl?.message).toContain("best-effort");
    expect(guard("verify.run", { kind: "test", cmd: "git", args: ["push"] }, { sessionId: "s1" })?.message).toContain('add "git"');
    expect(guard("os.shell.run", { cmd: "ssh host cat /etc/hosts" }, { sessionId: "s1" })?.message).toContain("no allowedEgress class allows it");
    expect(guard("os.shell.run", { cmd: "npm test" }, { sessionId: "s1" })).toBeNull();
    const allowed = createEgressGuard({ policyForSession: () => constrained(["http", "git"]), mcpEgress });
    expect(allowed("os.shell.run", { cmd: "curl https://example.com" }, { sessionId: "s1" })).toBeNull();
    expect(allowed("os.shell.run", { cmd: "git pull" }, { sessionId: "s1" })).toBeNull();
    expect(allowed("os.shell.run", { cmd: "scp a host:b" }, { sessionId: "s1" })).not.toBeNull();
    expect(createEgressGuard({ policyForSession: () => undefined })("os.shell.run", { cmd: "curl x" }, { sessionId: "s1" })).toBeNull();
  });

  it("asks for the policy of the dispatching session", () => {
    const policyForSession = vi.fn(() => undefined);
    createEgressGuard({ policyForSession, mcpEgress })("os.web.search", { query: "x" }, { sessionId: "s-42" });
    expect(policyForSession).toHaveBeenCalledWith("s-42");
  });
});

describe("ToolRegistry dispatch guard", () => {
  const ctx = (): ToolContext => ({ workingDir: "/work/client/app", sessionId: "s1", stepIndex: 0, signal: new AbortController().signal });

  it("refuses before the tool runs, so no approval and no request happen", async () => {
    const run = vi.fn(async () => compressToolResult({ tool: "os.web.fetch", status: "ok", output: "page" }));
    const guard = createEgressGuard({ policyForSession: () => constrained(), mcpEgress });
    const registry = new ToolRegistry({ dispatchGuard: guard });
    registry.register({ name: "os.web.fetch", description: "", readonly: true, run });
    expect(registry.refusalBeforeDispatch("os.web.fetch", { url: "https://example.com/" }, ctx())?.summary)
      .toContain('add "web" to projects.constraints');
    await expect(registry.invoke("os.web.fetch", { url: "https://example.com/" }, ctx()))
      .rejects.toBeInstanceOf(EgressNotAllowedError);
    expect(run).not.toHaveBeenCalled();
  });

  it("is a no-op without a guard", () => {
    const registry = new ToolRegistry();
    registry.register({ name: "os.web.fetch", description: "", readonly: true, run: async () => compressToolResult({ tool: "os.web.fetch", status: "ok", output: "" }) });
    expect(registry.refusalBeforeDispatch("os.web.fetch", { url: "https://example.com/" }, ctx())).toBeNull();
  });
});

describe("real network tools behind the guard", () => {
  it("os.web.fetch and os.http.request start no DNS, no curl and no approval in a constrained folder", async () => {
    const { buildOsWebFetchTool } = await import("./os/web/web-fetch.js");
    const { buildOsHttpRequestTool } = await import("./os/web/http-request.js");
    const { ApprovalGate } = await import("../approval/approval-gate.js");
    const runCommand = vi.fn(async () => { throw new Error("curl must not start"); });
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    const emit = vi.fn();
    const registry = new ToolRegistry({ dispatchGuard: createEgressGuard({ policyForSession: () => constrained(), mcpEgress }) });
    registry.register(buildOsWebFetchTool({ runCommand: runCommand as never, lookup }));
    registry.register(buildOsHttpRequestTool({
      lookup,
      approvals: new ApprovalGate({ emit }),
      approvalRequired: true,
      config: { http: { enabled: true, approvalMode: "always", hostAllowlist: null, maxResponseBytes: 1_048_576, defaultTimeoutMs: 30_000 } },
      runCommand: runCommand as never,
    }));
    const ctx: ToolContext = { workingDir: "/work/client/app", sessionId: "s1", stepIndex: 0, signal: new AbortController().signal };
    await expect(registry.invoke("os.web.fetch", { url: "https://example.com/" }, ctx)).rejects.toBeInstanceOf(EgressNotAllowedError);
    await expect(registry.invoke("os.http.request", { url: "https://api.example.com/v1", method: "POST", body: "{}" }, ctx))
      .rejects.toBeInstanceOf(EgressNotAllowedError);
    expect(runCommand).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});
