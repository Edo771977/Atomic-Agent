import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPolicy } from "./policy-active.js";
import { loadLocalPolicy } from "./policy-loader.js";
import * as paths from "../config/org-policy-paths.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { compressToolResult } from "../compressor/result-compressor.js";

afterEach(() => { installPolicy(null); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe("installed file policy survives visible environment changes", () => {
  it("registers file pins and explains how to retain them instead of resetting the environment", async () => {
    const root = mkdtempSync(join(tmpdir(), "policy-reset-file-"));
    try {
      for (const name of ["ATOMIC_AGENT_TOOL_CHILD", "ATOMIC_AGENT_POLICY_STATE_DIR", "ATOMIC_AGENT_POLICY_SYSTEM_PATH", "ATOMIC_AGENT_POLICY_FILE_PINS", "ATOMIC_POLICY_URL"]) vi.stubEnv(name, undefined);
      vi.spyOn(paths, "systemPolicyPath").mockReturnValue(join(root, "absent-system.json"));
      writeFileSync(join(root, "policy.json"), JSON.stringify({ version: 1, rules: [] }));
      const policy = loadLocalPolicy({ stateDir: root });
      expect(policy.filePins).toHaveLength(1);
      expect(process.env.ATOMIC_AGENT_POLICY_FILE_PINS).toBeUndefined();
      installPolicy(policy); // Exercises rememberPins, rather than a synthetic env value.
      expect(JSON.parse(process.env.ATOMIC_AGENT_POLICY_FILE_PINS!)).toEqual(policy.filePins);
      const run = vi.fn(async () => compressToolResult({ tool: "os.shell.run", status: "ok", output: "fixture" }));
      const registry = new ToolRegistry(); registry.register({ name: "os.shell.run", description: "fixture", readonly: false, run });
      const context = { sessionId: "fixture", stepIndex: 0, workingDir: root, signal: new AbortController().signal };
      for (const [cmd, args] of [["env", ["-i", "fixture"]], ["exec", ["-c", "fixture"]]] as const) {
        await expect(registry.invoke("os.shell.run", { cmd, args }, context)).rejects.toThrow(/Preserve.*ATOMIC_AGENT_POLICY_FILE_PINS.*env -u/s);
      }
      expect(run).not.toHaveBeenCalled();
      expect((await registry.invoke("os.shell.run", { cmd: "env", args: ["-u", "FIXTURE_UNRELATED", "fixture"] }, context)).status).toBe("ok");
      expect(run).toHaveBeenCalledOnce();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
