import { describe, expect, it } from "vitest";

import { makeProviderPolicy, runWithProviderPolicy } from "../../llm/provider-policy.js";
import { createRuntimeDispatchGuard, createRuntimeEgressGuard, isFusionWorkerTurn, mcpEgressClass } from "./runtime-egress-guard.js";

const servers: Record<string, { kind: "stdio" | "streamable_http" | "sse"; tools: string[]; local?: boolean }> = {
  files: { kind: "stdio", tools: ["mcp.files.read"], local: true },
  fetch: { kind: "stdio", tools: ["mcp.fetch.fetch"] },
  docs: { kind: "sse", tools: ["mcp.docs.search"] },
  composio: { kind: "streamable_http", tools: ["mcp.composio.COMPOSIO_SEARCH_TOOLS"] },
};
const manager = {
  serverForTool: (tool: string) => Object.entries(servers).find(([, s]) => s.tools.includes(tool))?.[0],
  transportKindOf: (server: string) => servers[server]?.kind,
  localOf: (server: string) => servers[server]?.local === true,
};

describe("runtime egress guard (issue #33)", () => {
  it("classes MCP calls by the server's transport", () => {
    expect(mcpEgressClass(manager, "mcp.files.read", {})).toBeNull();
    expect(mcpEgressClass(manager, "mcp.docs.search", {})).toBe("mcp:docs");
    expect(mcpEgressClass(manager, "mcp.composio.COMPOSIO_SEARCH_TOOLS", {})).toBe("composio");
    expect(mcpEgressClass(manager, "mcp.resource.read", { server: "files" })).toBeNull();
    // A stdio server not marked `local: true` may reach the network (issue #60).
    expect(mcpEgressClass(manager, "mcp.fetch.fetch", {})).toBe("mcp:fetch");
    expect(mcpEgressClass(manager, "mcp.resource.read", { server: "fetch" })).toBe("mcp:fetch");
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

  it("refuses a stdio server not marked local in a constrained folder, naming both fixes (issue #60)", () => {
    const policy = makeProviderPolicy({ key: "/w", allowedProviders: ["local-llama"], allowedEgress: [], matchedDir: "/w" });
    const guard = createRuntimeEgressGuard({ effectivePolicyForSession: () => policy, mcp: () => manager });
    const refusal = guard("mcp.fetch.fetch", {}, { sessionId: "s" })?.message ?? "";
    expect(refusal).toContain('add "mcp:fetch" to projects.constraints["/w"].allowedEgress');
    expect(refusal).toContain('set "local": true on its mcp.servers entry "fetch"');
    // A remote server's refusal offers no `local` way out.
    expect(guard("mcp.docs.search", {}, { sessionId: "s" })?.message).not.toContain('"local"');
    expect(guard("os.web.fetch", { url: "https://example.com" }, { sessionId: "s" })).not.toBeNull();
    const allowed = makeProviderPolicy({ key: "/w", allowedProviders: ["local-llama"], allowedEgress: ["mcp:fetch"], matchedDir: "/w" });
    const allowing = createRuntimeEgressGuard({ effectivePolicyForSession: () => allowed, mcp: () => manager });
    expect(allowing("mcp.fetch.fetch", {}, { sessionId: "s" })).toBeNull();
  });

  it("changes nothing in an unconstrained folder (issue #60)", () => {
    const guard = createRuntimeEgressGuard({ effectivePolicyForSession: () => undefined, mcp: () => manager });
    expect(guard("mcp.fetch.fetch", {}, { sessionId: "s" })).toBeNull();
    expect(guard("mcp.files.read", {}, { sessionId: "s" })).toBeNull();
    expect(guard("mcp.docs.search", {}, { sessionId: "s" })).toBeNull();
  });

  it("treats a stdio server as not local when the lookup cannot say (fail closed)", () => {
    const unsure = { ...manager, localOf: () => undefined };
    expect(mcpEgressClass(unsure, "mcp.files.read", {})).toBe("mcp:files");
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
