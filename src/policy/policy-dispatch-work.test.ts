import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as analysis from "../tools/os/shell/org-shell-analysis.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { compressToolResult } from "../compressor/result-compressor.js";
import { installPolicy } from "./policy-active.js";

afterEach(() => { installPolicy(null); vi.restoreAllMocks(); });
describe("bounded organization work through registry.invoke", () => {
  it.each([false, true])("scans only when required, loaded=%s", async loaded => {
    const scans = [vi.spyOn(analysis, "analyzeShellRules"), vi.spyOn(analysis, "shellRuleSegments"), vi.spyOn(analysis, "shellRunsUnreadableScript")];
    const root = join(tmpdir(), "definitely-missing-policy-dispatch-fixture");
    installPolicy({ sources: [{ kind: "user", state: "missing", location: join(root, "policy.json") }], mcpAllowlists: [], rules: loaded ? [{ source: "system", index: 0, action: "shell", resource: "unrelated*", effect: "deny" }] : [] });
    const registry = new ToolRegistry();
    registry.register({ name: "os.shell.run", description: "synthetic adapter", readonly: false, run: async () => compressToolResult({ tool: "os.shell.run", status: "ok", output: "fixture" }) });
    for (const cmd of ["echo " + "a".repeat(16 * 1024), "printf " + "a".repeat(16 * 1024), "cat <<'FIXTURE'\n" + "a".repeat(9 * 1024) + "\nFIXTURE"]) {
      scans.forEach(scan => scan.mockClear());
      const start = performance.now();
      expect((await registry.invoke("os.shell.run", { cmd }, { sessionId: "fixture", workingDir: root, stepIndex: 0, signal: new AbortController().signal })).status).toBe("ok");
      expect(scans.reduce((total, scan) => total + scan.mock.calls.length, 0)).toBe(loaded ? 1 : 0);
      console.info(JSON.stringify({ fixture: cmd.split(" ")[0], bytes: cmd.length, loaded, elapsedMs: performance.now() - start }));
    }
  });
});
