import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../tools/tool-registry.js";
import { buildOsShellTool } from "../tools/os/shell/shell.js";
import { ApprovalGate } from "../approval/approval-gate.js";
import * as jobs from "../sandbox/command-job.js";
import * as parser from "../tools/os/shell/org-shell-analysis.js";
import { installPolicy } from "./policy-active.js";
import { programName } from "../tools/os/shell-command-guard/command-segments.js";
import { resolveShellSpawn } from "../tools/os/shell/shell-interpretation.js";

afterEach(() => { installPolicy(null); vi.restoreAllMocks(); });
describe("real shell pipeline with a fake executor", () => {
  it("still evaluates the concrete trusted shell wrapper without executing it", async () => {
    const spawn = resolveShellSpawn("echo fixture", [], true);
    installPolicy({ sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "shell", resource: programName(spawn.command) + "*", effect: "deny" }] });
    const executor = vi.spyOn(jobs, "startCommandJob").mockImplementation(() => { throw new Error("synthetic executor reached"); });
    const registry = new ToolRegistry(); registry.register(buildOsShellTool({ approvals: new ApprovalGate({ level: 5, emit: () => undefined }), approvalRequired: false }));
    await expect(registry.invoke("os.shell.run", { cmd: "echo fixture" }, { sessionId: "fixture", workingDir: process.cwd(), stepIndex: 0, signal: new AbortController().signal })).rejects.toThrow(/policy/);
    expect(executor).not.toHaveBeenCalled();
  });
  it.each(["none", "rules", "file"])("shares organization work through registry and tool, loaded=%s", async mode => {
    const loaded = mode !== "none";
    const root = mkdtempSync(join(tmpdir(), "policy-invoke-work-"));
    if (mode === "file") writeFileSync(join(root, "policy.json"), "{}");
    installPolicy({ sources: mode === "file" ? [{ kind: "user", state: "loaded", location: join(root, "policy.json") }] : [], mcpAllowlists: [], rules: mode === "rules" ? [{ source: "system", index: 0, action: "shell", resource: "unrelated*", effect: "deny" }] : [] });
    vi.spyOn(jobs, "startCommandJob").mockImplementation(() => { throw new Error("synthetic executor reached"); });
    const scan = vi.spyOn(parser, "analyzeShellRules");
    const registry = new ToolRegistry(); registry.register(buildOsShellTool({ approvals: new ApprovalGate({ level: 5, emit: () => undefined }), approvalRequired: false }));
    try { for (const cmd of ["echo " + "a".repeat(16 * 1024), "printf " + "a".repeat(16 * 1024), "cat <<'FIXTURE'\n" + "a".repeat(9 * 1024) + "\nFIXTURE"]) {
      scan.mockClear(); const start = performance.now();
      await expect(registry.invoke("os.shell.run", { cmd }, { sessionId: "fixture", workingDir: process.cwd(), stepIndex: 0, signal: new AbortController().signal })).rejects.toThrow("synthetic executor reached");
      expect(scan).toHaveBeenCalledTimes(loaded ? 1 : 0);
      const elapsedMs = performance.now() - start;
      console.info(JSON.stringify({ fixture: cmd.split(" ")[0], bytes: cmd.length, loaded, elapsedMs }));
      // Wall-clock samples are recorded; deterministic work counts are the regression contract.
    } } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
