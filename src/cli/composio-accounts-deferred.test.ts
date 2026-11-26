import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("rejects Composio account access in the real offline child CLI without disclosing input or creating state", () => {
  const dir = mkdtempSync(join(tmpdir(), "b4c-absent-cli-"));
  const sentinel = "b4c_private_stdin_sentinel_f7209e";
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli/index.ts", "composio", "accounts", "list", "--connected"], {
      cwd: process.cwd(), encoding: "utf8", input: `${sentinel}\n`, timeout: 20_000,
      env: { ...process.env, ATOMIC_AGENT_STATE_DIR: dir, ATOMIC_AGENT_TOOL_CHILD: "1", ATOMIC_AGENT_OFFLINE: "1", ATOMIC_AGENT_DEBUG_ARGV: "0" },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown command: composio");
    expect(result.stdout + result.stderr).not.toContain(sentinel);
    expect(readdirSync(dir)).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);
