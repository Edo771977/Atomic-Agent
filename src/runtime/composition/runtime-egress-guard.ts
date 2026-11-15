import { COMPOSIO_SERVER_NAME } from "../../composio/index.js";
import type { ProjectConstraintsConfig } from "../../config/tool-config.js";
import { currentProviderPolicyFrame, type ProviderPolicy } from "../../llm/provider-policy.js";
import type { McpManager } from "../../mcp/mcp-manager.js";
import { FUSION_TMP_PREFIX } from "../../tools/fusion/branch-workspace.js";
import { createEgressGuard, MCP_META_TOOLS, type EgressClass } from "../../tools/tool-egress.js";
import { createWriteOutGuard } from "../../tools/tool-write-out.js";

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

/**
 * A fusion worker's own temp copy (a folder under the fusion temp area,
 * `atag-fusion-*`), when the turn running now is that worker's: the one
 * place a constrained session may write outside its folder.
 */
export function fusionWorkerScratchDir(sessionId: string, workingDir: string): string | undefined {
  const frame = currentProviderPolicyFrame();
  if (frame?.role !== "a fusion worker" || frame.sessionId !== sessionId) return undefined;
  return workingDir.split(/[\\/]/).some((part) => part.startsWith(FUSION_TMP_PREFIX)) ? workingDir : undefined;
}

/**
 * The registry's whole dispatch guard: egress first, then the write-out
 * rule (`tools/tool-write-out.ts`), both against the same effective policy.
 */
export function createRuntimeDispatchGuard(deps: {
  effectivePolicyForSession: (sessionId: string) => ProviderPolicy | undefined;
  mcp: () => McpLookup | undefined;
  readConfig: () => { projects: { constraints?: ProjectConstraintsConfig } };
}) {
  const egress = createRuntimeEgressGuard(deps);
  const writeOut = createWriteOutGuard({
    policyForSession: deps.effectivePolicyForSession,
    readConfig: deps.readConfig,
    ownScratchDir: fusionWorkerScratchDir,
  });
  return (tool: string, args: Record<string, unknown>, ctx: { sessionId: string; workingDir?: string }): Error | null =>
    egress(tool, args, ctx) ?? writeOut(tool, args, ctx);
}
