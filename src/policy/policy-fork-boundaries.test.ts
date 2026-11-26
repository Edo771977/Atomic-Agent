import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../tools/tool-registry.js";
import { compressToolResult } from "../compressor/result-compressor.js";
import { policyCommand } from "../cli/policy-command.js";
import { setOfflineNetwork } from "../llm/offline-network.js";
import { installPolicy } from "./policy-active.js";
import { loadLocalPolicy, loadPolicy, mergePolicySources } from "./policy-loader.js";
import { policyCallRefusal, policyRuleMatch } from "./policy-enforce.js";
import { parsePolicyFile } from "./policy-schema.js";
import { ApprovalGate } from "../approval/approval-gate.js";
import { authorizeVerifyBatch } from "../tools/verify/verify-authorization.js";
import { runVerify } from "../tools/verify/run-verify.js";
import { buildOsFsWriteTool } from "../tools/os/fs/fs-write.js";
import { spawnVerifyProcess } from "../tools/verify/spawn-verify-process.js";

const policy = (action: string, resource = "*", effect = "deny") => mergePolicySources([{
  status: { kind: "system", location: "fixture", state: "loaded" },
  file: parsePolicyFile({ rules: [{ action, resource, effect }] }),
}]);
afterEach(() => { installPolicy(null); setOfflineNetwork(false); vi.unstubAllEnvs(); });

describe("fork organization policy boundaries", () => {
  it.each([{ typo: [] }, { rules: [{ action: "shell", effect: "deny", resorce: "rm *" }] }, { mcpAllowlist: { servers: [], warnOny: true } }])("rejects unknown keys: %j", value => {
    expect(() => parsePolicyFile(value)).toThrow(/unknown/i);
  });
  it.each(["{broken", JSON.stringify({ typo: true })])("refuses a malformed local policy: %s", text => {
    expect(() => loadLocalPolicy({ stateDir: "fixture", platform: "linux", env: {}, readText: () => text })).toThrow(/policy/i);
  });
  it("refuses unreadable local policy rather than dropping its restrictions", async () => {
    await expect(loadPolicy({ stateDir: "fixture", env: {}, readText: () => { throw new Error("EACCES"); } })).rejects.toThrow(/policy/i);
  });
  it("does not call the policy server while offline, even with an injected transport", async () => {
    setOfflineNetwork(true);
    const fetchText = vi.fn(async () => "{}");
    await loadPolicy({ stateDir: "fixture", env: { ATOMIC_POLICY_URL: "https://policy.test/rules" }, readText: () => null, fetchText });
    expect(fetchText).not.toHaveBeenCalled();
  });
  it("policy show refuses tool children before reading or fetching anything", async () => {
    vi.stubEnv("ATOMIC_AGENT_TOOL_CHILD", "1");
    const load = vi.fn(async () => policy("shell"));
    const write = vi.fn();
    expect(await policyCommand(["show", "--json"], { load, write, writeErr: () => undefined })).toBe(1);
    expect(load).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  });
  it("a tool child retains system restrictions with a replacement state directory", async () => {
    vi.stubEnv("ATOMIC_AGENT_TOOL_CHILD", "1");
    const readText = vi.fn((path: string) => path.includes("AtomicAgent") || path.includes("atomic-agent/policy.json") ? JSON.stringify({ rules: [{ action: "shell", effect: "deny" }] }) : null);
    for (const p of [loadLocalPolicy({ stateDir: "replacement", env: {}, readText }), await loadPolicy({ stateDir: "replacement", env: {}, readText })]) {
      expect(policyCallRefusal(p, "os.shell.run", { cmd: "fixture" })).toContain("policy");
    }
  });
  it.each(["os.web.search", "mcp.corp.read", "os.fs.write"])("direct registry invocation cannot bypass deny for %s", async tool => {
    installPolicy(policy(tool === "os.web.search" ? "websearch" : tool.startsWith("mcp.") ? "mcp" : "edit"));
    const run = vi.fn(async () => compressToolResult({ tool, status: "ok", output: "ran" }));
    const registry = new ToolRegistry();
    registry.register({ name: tool, readonly: true, description: "fixture", run });
    await expect(registry.invoke(tool, { query: "q", path: "out" }, { workingDir: process.cwd(), sessionId: "fusion-worker-fixture", stepIndex: 0, signal: new AbortController().signal })).rejects.toThrow(/organization.*policy/i);
    expect(run).not.toHaveBeenCalled();
  });
  it("verify command and service executors inherit shell denials", () => {
    const p = policy("shell", "npm publish*");
    expect(policyCallRefusal(p, "verify.run", { kind: "command", cmd: "npm", args: ["publish"] })).toContain("policy");
    expect(policyCallRefusal(p, "verify.run", { kind: "service", start: { cmd: "npm", args: ["publish"] } })).toContain("policy");
    expect(policyCallRefusal(p, "verify.run", { kind: "command", cmd: "bash", stdin: "npm publish" })).toContain("policy");
  });
  it("verification pages and service probes cannot bypass web denies", () => {
    const p = policy("webfetch", "evil.test");
    expect(policyCallRefusal(p, "verify.run", { kind: "page", url: "https://evil.test/page" })).toContain("policy");
    expect(policyCallRefusal(p, "verify.run", { kind: "service", ready: { url: "https://evil.test/ready" }, requests: [{ url: "https://evil.test/api" }] })).toContain("policy");
  });
  it("a host cannot retarget an approved write into a policy-denied path on the same approval rung", async () => {
    const dir = mkdtempSync(join(tmpdir(), "policy-retarget-"));
    const destination = join(dir, "forbidden.txt"); installPolicy(policy("edit", "*forbidden.txt"));
    const gate = new ApprovalGate({ level: 1, emit: request => gate.resolve({ approvalId: request.approvalId, approved: true, pathOverride: destination }) });
    gate.setOrgPolicy(request => policyRuleMatch(policy("edit", "*forbidden.txt"), request));
    try {
      const tool = buildOsFsWriteTool({ approvals: gate, approvalRequired: true });
      await expect(tool.run({ path: join(dir, "allowed.txt"), content: "fixture" }, { workingDir: dir, sessionId: "s", stepIndex: 0, signal: new AbortController().signal })).rejects.toThrow(/organization.*policy/i);
      expect(existsSync(destination)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("trust-config writes still obey edit denies", () => {
    expect(policyRuleMatch(policy("edit"), { tool: "os.fs.write", category: "trust_config", targetPaths: ["config.json"] })?.decision).toBe("deny");
    expect(policyRuleMatch(policy("edit", "*", "ask"), { tool: "os.fs.write", category: "other", affectedResources: ["/outside/file"] })?.decision).toBe("ask");
  });
  it("fixed verification executors, including UI detectors, check policy before spawning", () => {
    installPolicy(policy("shell"));
    expect(() => spawnVerifyProcess("nonexistent-policy-fixture", [], { cwd: process.cwd(), workspaceRoot: process.cwd(), network: false, timeoutMs: 1000 })).toThrow(/organization.*policy/i);
  });
  it.each(["state_secret", "trust_config"] as const)("agent requests cannot read or rewrite policy through %s approvals", async category => {
    const p = loadLocalPolicy({ stateDir: process.cwd(), env: {}, readText: () => null });
    const gate = new ApprovalGate({ level: 5, emit: () => { throw new Error("must not ask"); } });
    gate.setOrgPolicy(request => policyRuleMatch(p, request));
    const answer = await gate.request({ sessionId: "s", tool: "os.fs.write", category, reason: "fixture", affectedResources: [p.sources[0]!.location] });
    expect(answer.approved).toBe(false);
  });
  it("recognized shell reads and replacements of policy use the secret/state scanner even outside runtime dispatch", () => {
    const root = mkdtempSync(join(tmpdir(), "policy-existing-boundary-"));
    const path = join(root, "policy.json"); writeFileSync(path, "{}");
    try {
      const p = loadLocalPolicy({ stateDir: root, env: {}, readText: file => file === path ? "{}" : null });
      expect(policyCallRefusal(p, "os.shell.run", { cmd: "cat", args: [path] }, root)).toContain("protected");
      expect(policyCallRefusal(p, "os.shell.run", { cmd: `echo '{}' > "${path}"` }, root)).toContain("protected");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("Fusion contract checks refuse deny even when an embedder turns approvals off", async () => {
    installPolicy(policy("shell", "node forbidden*"));
    await expect(authorizeVerifyBatch([{ kind: "command", cmd: "node", args: ["forbidden.js"] }], { approvals: {} as never, approvalRequired: false }, {
      sessionId: "fusion-worker-fixture", workingDir: process.cwd(), stepIndex: 0, signal: new AbortController().signal,
    })).rejects.toThrow(/organization.*policy/i);
  });
  it("the actual rebased verify executor rechecks policy before it runs", async () => {
    installPolicy(policy("shell", "node forbidden*"));
    const dir = mkdtempSync(join(tmpdir(), "policy-verify-copy-"));
    try {
      const result = await runVerify({ kind: "command", cmd: "node", args: ["forbidden.js"] }, {
        workingDir: process.cwd(), signal: new AbortController().signal,
        workspace: async () => ({ dir, isolated: true, method: "copy", cleanup: async () => undefined }),
      });
      expect(result.ok).toBe(false); expect(result.error).toMatch(/organization.*policy/i);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
