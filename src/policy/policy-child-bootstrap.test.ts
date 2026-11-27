import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../tools/tool-registry.js";
import { compressToolResult } from "../compressor/result-compressor.js";
import { installPolicy } from "./policy-active.js";
import { loadLocalPolicy, loadPolicy } from "./policy-loader.js";
import { evaluatePolicy } from "./policy-evaluator.js";
import * as paths from "../config/org-policy-paths.js";

afterEach(() => { installPolicy(null); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe("tool-child policy bootstrap", () => {
  it("a marker-only child invokes an ordinary registry tool without policy", async () => {
    const root = mkdtempSync(join(tmpdir(), "policy-child-"));
    try {
      vi.stubEnv("ATOMIC_AGENT_TOOL_CHILD", "1"); vi.stubEnv("ATOMIC_AGENT_STATE_DIR", root);
      vi.spyOn(paths, "systemPolicyPath").mockReturnValue(join(root, "system.json")); installPolicy(null);
      const registry = new ToolRegistry();
      registry.register({ name: "fixture.read", description: "fixture", readonly: true,
        run: async () => compressToolResult({ tool: "fixture.read", status: "ok", output: "ordinary" }) });
      expect((await registry.invoke("fixture.read", {}, { sessionId: "fixture", stepIndex: 0, workingDir: root, signal: new AbortController().signal })).status).toBe("ok");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("intersects inherited local/cache restrictions without the stripped delivery URL", async () => {
    const root = mkdtempSync(join(tmpdir(), "policy-child-"));
    try {
      vi.stubEnv("ATOMIC_AGENT_TOOL_CHILD", "1"); vi.stubEnv("ATOMIC_AGENT_POLICY_STATE_DIR", root);
      vi.spyOn(paths, "systemPolicyPath").mockReturnValue(join(root, "system.json"));
      writeFileSync(join(root, "policy.json"), JSON.stringify({ rules: [{ action: "shell", resource: "fixture-a*", effect: "ask" }] }));
      writeFileSync(join(root, "policy-cache.json"), JSON.stringify({ url: "https://fixture.test/policy", fetchedAt: "fixture", policy: { rules: [{ action: "shell", resource: "fixture-b*", effect: "deny" }] } }));
      const fetchText = vi.fn();
      const p = await loadPolicy({ stateDir: join(root, "other"), fetchText });
      expect(evaluatePolicy(p, "shell", ["fixture-a"])?.effect).toBe("ask");
      expect(evaluatePolicy(p, "shell", ["fixture-b"])?.effect).toBe("deny");
      expect(fetchText).not.toHaveBeenCalled();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("refuses a malformed child cache rather than losing restrictions", () => {
    expect(() => loadLocalPolicy({ stateDir: "fixture", env: { ATOMIC_AGENT_TOOL_CHILD: "1" },
      readText: path => path.endsWith("policy-cache.json") ? "{bad" : null })).toThrow(/cache/i);
  });
  it("keeps the inherited system source when the child has another system-directory environment", () => {
    const root = mkdtempSync(join(tmpdir(), "policy-child-"));
    try {
      const original = join(root, "admin.json");
      writeFileSync(original, JSON.stringify({ rules: [{ action: "shell", effect: "deny" }] }));
      vi.stubEnv("ATOMIC_AGENT_TOOL_CHILD", "1"); vi.stubEnv("ATOMIC_AGENT_POLICY_SYSTEM_PATH", original);
      vi.spyOn(paths, "systemPolicyPath").mockReturnValue(join(root, "other.json"));
      expect(evaluatePolicy(loadLocalPolicy({ stateDir: root }), "shell", ["fixture"])?.effect).toBe("deny");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("does not start a parent with fresh remote restrictions that children cannot obtain from cache", async () => {
    await expect(loadPolicy({ stateDir: "fixture", env: { ATOMIC_POLICY_URL: "https://fixture.test/policy" }, readText: () => null,
      fetchText: async () => JSON.stringify({ rules: [{ action: "shell", effect: "deny" }] }), writeText: () => { throw new Error("fixture unavailable cache"); } })).rejects.toThrow(/cache/i);
  });
});
