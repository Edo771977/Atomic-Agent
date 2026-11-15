import { describe, expect, it } from "vitest";

import { makeProviderPolicy, runWithProviderPolicy } from "../../llm/provider-policy.js";
import { createRuntimeDispatchGuard, createRuntimeEgressGuard, isFusionWorkerTurn, mcpEgressClass } from "./runtime-egress-guard.js";

const servers: Record<string, { kind: "stdio" | "streamable_http" | "sse"; tools: string[] }> = {
  files: { kind: "stdio", tools: ["mcp.files.read"] },
  docs: { kind: "sse", tools: ["mcp.docs.search"] },
  composio: { kind: "streamable_http", tools: ["mcp.composio.COMPOSIO_SEARCH_TOOLS"] },
};
const manager = {
  serverForTool: (tool: string) => Object.entries(servers).find(([, s]) => s.tools.includes(tool))?.[0],
  transportKindOf: (server: string) => servers[server]?.kind,
};

describe("runtime egress guard (issue #33)", () => {
  it("classes MCP calls by the server's transport", () => {
    expect(mcpEgressClass(manager, "mcp.files.read", {})).toBeNull();
    expect(mcpEgressClass(manager, "mcp.docs.search", {})).toBe("mcp:docs");
    expect(mcpEgressClass(manager, "mcp.composio.COMPOSIO_SEARCH_TOOLS", {})).toBe("composio");
    expect(mcpEgressClass(manager, "mcp.resource.read", { server: "files" })).toBeNull();
    expect(mcpEgressClass(manager, "mcp.prompt.get", { server: "docs" })).toBe("mcp:docs");
    // Unknown to the manager: the classifier then fails closed on the name.
    expect(mcpEgressClass(manager, "mcp.gone.x", {})).toBeUndefined();
    expect(mcpEgressClass(undefined, "mcp.docs.search", {})).toBeUndefined();
  });

  it("refuses a remote MCP server in a constrained folder and keeps stdio servers usable", () => {
    const policy = makeProviderPolicy({ key: "/w", allowedProviders: ["local-llama"], matchedDir: "/w" });
    const guard = createRuntimeEgressGuard({ effectivePolicyForSession: () => policy, mcp: () => manager });
    expect(guard("mcp.docs.search", {}, { sessionId: "s" })?.message).toContain('add "mcp:docs"');
    expect(guard("mcp.composio.COMPOSIO_SEARCH_TOOLS", {}, { sessionId: "s" })?.message).toContain('add "composio"');
    expect(guard("mcp.files.read", {}, { sessionId: "s" })).toBeNull();
  });

  it("adds the write-out rule, exempting only a fusion worker's own temp copy", () => {
    const policy = makeProviderPolicy({ key: "/work/secret", allowedProviders: ["local-llama"], matchedDir: "/work/secret" });
    const guard = createRuntimeDispatchGuard({
      effectivePolicyForSession: () => policy,
      mcp: () => manager,
      readConfig: () => ({ projects: { constraints: { "/work/secret": { allowedProviders: ["local-llama"] } } } }),
    });
    const copy = "/tmp/atag-fusion-abc123-x/task-1";
    expect(guard("os.fs.write", { path: "/work/open/a" }, { sessionId: "s", workingDir: "/work/secret" })?.message).toContain("would write its content");
    expect(guard("os.fs.write", { path: "a" }, { sessionId: "s", workingDir: "/work/secret" })).toBeNull();
    expect(guard("os.fs.write", { path: "a" }, { sessionId: "w", workingDir: copy })).not.toBeNull();
    const inWorker = runWithProviderPolicy(policy, () => guard("os.fs.write", { path: "a" }, { sessionId: "w", workingDir: copy }), { role: "a fusion worker", sessionId: "w" });
    expect(inWorker).toBeNull();
    const otherSession = runWithProviderPolicy(policy, () => guard("os.fs.write", { path: "a" }, { sessionId: "s2", workingDir: copy }), { role: "a fusion worker", sessionId: "w" });
    expect(otherSession).not.toBeNull();
  });
});

describe("isFusionWorkerTurn (the LSP skip for workers, ATO-503)", () => {
  it("is true only inside that worker's own turn", () => {
    const policy = makeProviderPolicy({ key: "/p", allowedProviders: ["a"], matchedDir: "/p" });
    expect(isFusionWorkerTurn("w")).toBe(false);
    expect(runWithProviderPolicy(policy, () => isFusionWorkerTurn("w"), { role: "a fusion worker", sessionId: "w" })).toBe(true);
    expect(runWithProviderPolicy(policy, () => isFusionWorkerTurn("s2"), { role: "a fusion worker", sessionId: "w" })).toBe(false);
    expect(runWithProviderPolicy(policy, () => isFusionWorkerTurn("w"), { role: "the main model", sessionId: "w" })).toBe(false);
  });
});
