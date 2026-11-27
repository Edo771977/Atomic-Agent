import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseMcpServers } from "../config/mcp-server-config.js";
import { buildOsSandboxPolicy, buildSeatbeltProfile, readOsSandboxSettings, wrapWithOsSandbox } from "../sandbox/os-sandbox.js";
import { McpClient } from "./mcp-client.js";

it("does not activate an MCP sandbox opt-out or Docker grant through configuration", () => {
  for (const sandbox of [false, true, { allowDocker: true }]) {
    const server = parseMcpServers([{ name: "probe", transport: { kind: "stdio", command: process.execPath }, sandbox }], "mcp.servers")[0];
    expect(server).not.toHaveProperty("sandbox");
  }
});
it("keeps the deferred MCP launch wrapper and path reopening helper absent", () => {
  const client = new McpClient({ name: "probe", enabled: true, transport: { kind: "stdio", command: process.execPath } });
  expect("sandboxedSpawn" in client).toBe(false);
  expect(existsSync(new URL("./mcp-sandbox-paths.ts", import.meta.url))).toBe(false);
});
it("preserves main's optional command sandbox and actual platform distinction", () => {
  expect(readOsSandboxSettings({}).mode).toBe("off");
  const policy = buildOsSandboxPolicy({ workspaceRoots: [], stateDir: join(homedir(), ".atomic-b6-fixture-state"), network: false });
  expect(wrapWithOsSandbox(process.execPath, [], policy, { platform: "win32" }).ok).toBe(false);
  const mac = wrapWithOsSandbox("/usr/bin/true", [], policy, { platform: "darwin", seatbeltAvailable: true });
  expect(mac.ok).toBe(true);
  if (mac.ok) expect(mac.command).toBe("/usr/bin/sandbox-exec");
  expect(buildSeatbeltProfile(policy)).toContain('(allow network-outbound (remote ip "localhost:*"))');
});
