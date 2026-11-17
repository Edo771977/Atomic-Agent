import { existsSync } from "node:fs";

import { parseUserConfigFile } from "../config/index.js";
import { readRawConfigTree } from "../config/config-paths.js";
import { listMcpCatalog, MCP_CATALOG_PLACEHOLDER_RE } from "../mcp/mcp-catalog.js";
import type { McpCatalogServer } from "../mcp/mcp-catalog-types.js";
import type { DoctorContext, DoctorFinding } from "./doctor-checks.js";

/** A whole `<your ...>` argument of a catalog entry: any one non-empty value matches it. */
function isPlaceholderArg(arg: string): boolean {
  MCP_CATALOG_PLACEHOLDER_RE.lastIndex = 0;
  return arg.replace(MCP_CATALOG_PLACEHOLDER_RE, "") === "" && arg.length > 0;
}

function matchesCatalogServer(command: string, args: readonly string[], entry: McpCatalogServer): boolean {
  if (entry.command !== command) return false;
  const want = entry.args ?? [];
  // A trailing placeholder takes one or more values (filesystem lists several folders).
  const last = want.at(-1);
  const variadic = last !== undefined && isPlaceholderArg(last);
  if (variadic ? args.length < want.length : args.length !== want.length) return false;
  return want.every((w, i) => (isPlaceholderArg(w) ? args[i]!.length > 0 : w === args[i]));
}

/**
 * Issue #60 upgrade gap: a stdio server added from the catalog before
 * the `local` flag existed (filesystem, git, time, memory, sequential
 * thinking) has no `local: true`, so every folder with an egress
 * constraint now refuses its tools. Warn, only while a constraint
 * exists, about each such server whose command and arguments match a
 * catalog entry marked local, and name the fix. Nothing is changed in
 * the file: whether a server stays off the network is the operator's
 * call, not ours.
 */
export function checkMcpLocalMarks(ctx: DoctorContext): DoctorFinding[] {
  if (!existsSync(ctx.configPath)) return [];
  let config: ReturnType<typeof parseUserConfigFile>;
  try {
    config = parseUserConfigFile(readRawConfigTree(ctx.configPath));
  } catch {
    return [];
  }
  if (Object.keys(config.projects.constraints).length === 0) return [];
  const localEntries = listMcpCatalog().filter((e) => e.server.local === true);
  const out: DoctorFinding[] = [];
  config.mcp.servers.forEach((server, i) => {
    if (server.transport.kind !== "stdio" || server.local === true) return;
    const { command, args = [] } = server.transport;
    if (!localEntries.some((e) => matchesCatalogServer(command, args, e.server))) return;
    out.push({
      check: "mcp-local",
      status: "warn",
      message: `${server.name}: a catalog server that works on local data, without "local": true, so folders with an egress constraint refuse its tools; ` +
        `set "local": true on mcp.servers[${i}] in config.json, or add ${JSON.stringify(`mcp:${server.name}`)} to the folder's allowedEgress`,
    });
  });
  return out;
}
