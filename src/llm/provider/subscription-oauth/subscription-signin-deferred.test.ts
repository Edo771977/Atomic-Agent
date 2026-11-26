import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { registerBuiltInProviderKinds } from "../registry/register-built-in-providers.js";
import { getProviderFactory } from "../registry/provider-types.js";

it("does not register an OAuth cloud provider or activate a token store", () => {
  registerBuiltInProviderKinds();
  expect(getProviderFactory("subscription-oauth")).toBeUndefined();
  expect(getProviderFactory("subscription-cli")).toBeTypeOf("function");
  for (const path of ["credential-store.ts", "chatgpt-codex.ts", "github-copilot.ts", "subscription-oauth-provider.ts"]) {
    expect(existsSync(new URL(path, import.meta.url))).toBe(false);
  }
});

it.each(["chatgpt", "copilot"])("keeps %s login/logout absent offline and in a marked child, with no token or chat state", service => {
  const dir = mkdtempSync(join(tmpdir(), "b4b-absent-"));
  const sentinel = "b4b_absence_private_sentinel_c40f87";
  try {
    for (const command of ["login", "logout"]) {
      const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli/index.ts", command, service], {
        cwd: process.cwd(), encoding: "utf8", input: `${sentinel}\n`, timeout: 20_000,
        env: { ...process.env, ATOMIC_AGENT_STATE_DIR: dir, ATOMIC_AGENT_TOOL_CHILD: "1", ATOMIC_AGENT_OFFLINE: "1", ATOMIC_AGENT_DEBUG_ARGV: "0" },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`unknown command: ${command}`);
      expect(result.stdout + result.stderr).not.toContain(sentinel);
      expect(readdirSync(dir)).toEqual([]);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 45_000);
