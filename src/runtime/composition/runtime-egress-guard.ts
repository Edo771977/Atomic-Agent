import { COMPOSIO_SERVER_NAME } from "../../composio/index.js";
import type { ProviderPolicy } from "../../llm/provider-policy.js";
import type { McpManager } from "../../mcp/mcp-manager.js";
import { createEgressGuard, MCP_META_TOOLS, type EgressClass } from "../../tools/tool-egress.js";

type McpLookup = Pick<McpManager, "serverForTool" | "transportKindOf">;

/**
 * The egress class of an MCP call (issue #33): `null` for a stdio server
 * (a local process), `"composio"` for the Composio server, `mcp:<server>`
 * for any other remote (http / SSE) server, `undefined` when the manager
 * does not know the server (the classifier then fails closed on the name).
 */
export function mcpEgressClass(
  manager: McpLookup | undefined,
  tool: string,
  args: Record<string, unknown>,
): EgressClass | null | undefined {
  if (manager === undefined) return undefined;
  const server = MCP_META_TOOLS.has(tool)
    ? (typeof args.server === "string" && args.server.length > 0 ? args.server : undefined)
    : manager.serverForTool(tool);
  if (server === undefined) return undefined;
  const kind = manager.transportKindOf(server);
  if (kind === undefined) return undefined;
  if (kind === "stdio") return null;
  return server === COMPOSIO_SERVER_NAME ? "composio" : `mcp:${server}`;
}

/**
 * The tool registry's dispatch guard: the folder's egress constraint,
 * read through `effectivePolicyForSession` (session-provider-policy.ts),
 * with MCP servers classed by the live manager (`mcp()`, created after
 * the registry; `undefined` until then).
 */
export function createRuntimeEgressGuard(deps: {
  effectivePolicyForSession: (sessionId: string) => ProviderPolicy | undefined;
  mcp: () => McpLookup | undefined;
}) {
  return createEgressGuard({
    policyForSession: deps.effectivePolicyForSession,
    mcpEgress: (tool, args) => mcpEgressClass(deps.mcp(), tool, args),
  });
}
