import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildMcpStdioEnv } from "../mcp/mcp-stdio-env.js";

describe("embedded atomic-agent MCP stdio child", () => {
  it("starts with the real child marker and retains inherited deny and ask", async () => {
    const root = mkdtempSync(join(tmpdir(), "policy-mcp-child-"));
    const state = join(root, "config.json");
    writeFileSync(state, JSON.stringify({ agent: { approvalLevel: 5 }, memory: { notes: { enabled: false }, profile: { enabled: false }, lessons: { enabled: false }, procedures: { enabled: false } } }));
    const base = { ...process.env, ATOMIC_AGENT_STATE_DIR: root, ProgramData: root, ATOMIC_AGENT_POLICY_SYSTEM_PATH: join(root, "admin.json"), ATOMIC_AGENT_POLICY_STATE_DIR: root };
    const env = buildMcpStdioEnv({ ATOMIC_AGENT_STATE_DIR: root }, base);
    expect(env.ATOMIC_AGENT_TOOL_CHILD).toBe("1");
    const script = "import {mcpServerCommand} from './src/cli/mcp-server-command.ts'; process.exitCode=await mcpServerCommand(['--allow-exec','--tool','os.shell.run','--cwd',process.env.ATOMIC_AGENT_STATE_DIR]);";
    try {
      for (const effect of [null, "deny", "ask"] as const) {
        if (effect !== null) writeFileSync(join(root, "policy.json"), JSON.stringify({ rules: [{ action: "shell", resource: "node *", effect }] }));
        const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "--input-type=module", "-e", script], env, stderr: "pipe", cwd: process.cwd() });
        let stderr = ""; transport.stderr?.on("data", data => { stderr += String(data); });
        const client = new Client({ name: "fixture", version: "1" });
        try {
          await client.connect(transport);
          expect((await client.listTools()).tools.map(tool => tool.name)).toContain("os_shell_run");
          const result = await client.callTool({ name: "os_shell_run", arguments: { cmd: process.execPath, args: ["--version"] } });
          expect(Boolean(result.isError), stderr).toBe(effect !== null);
          if (effect !== null) expect(JSON.stringify(result)).toMatch(/policy|approval/i);
        } finally { await client.close(); await transport.close(); }
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
