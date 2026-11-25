import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installPolicy } from "../policy/policy-active.js";
import { loadLocalPolicy } from "../policy/policy-loader.js";
import { configCommand } from "../cli/config-command.js";
import { hashHttpToken } from "./http-token-store.js";
import { startTestHarness, type Harness } from "./test-harness.js";

describe("organization policy across fork HTTP and config surfaces", () => {
  let harness: Harness; let file: string; let bytes: string;
  beforeEach(async () => {
    harness = await startTestHarness({ apiKey: "owner-key", approvalLevel: 5,
      namedTokens: () => [{ name: "member", role: "member", sha256: hashHttpToken("member-key"), createdAt: new Date(0).toISOString() }] });
    file = join(harness.stateDir, "policy.json");
    bytes = JSON.stringify({ rules: [{ action: "shell", resource: "*", effect: "deny" }] });
    writeFileSync(file, bytes);
    installPolicy(loadLocalPolicy({ stateDir: harness.stateDir }));
  });
  afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await harness.cleanup(); installPolicy(null); });
  const post = (path: string, body: unknown, key = "owner-key", method = "POST") => fetch(`${harness.baseUrl}${path}`, {
    method, headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body),
  });
  const denied = () => harness.runtime.approvals.request({ approvalId: "policy-denied", sessionId: "s", tool: "os.shell.run", category: "shell", commandArgv: ["node", "test.js"], reason: "fixture" });

  it("the owner cannot resurrect a policy-denied call through HTTP approval", async () => {
    expect((await denied()).approved).toBe(false);
    expect(harness.approvalBus.snapshot()).toEqual([]);
    expect((await post("/api/approval/resolve", { approvalId: "policy-denied", decision: "allow-always" })).status).toBe(404);
    expect((await denied()).approved).toBe(false);
  });
  it("a saved allow and its HTTP deletion never cancel an organization deny", async () => {
    const store = harness.runtime.approvals.getRules()!;
    const rule = store.add({ decision: "allow", category: "shell", source: "user" });
    expect((await denied()).approved).toBe(false);
    const result = await fetch(`${harness.baseUrl}/api/approval-rules/${rule.id}`, { method: "DELETE", headers: { authorization: "Bearer owner-key" } });
    expect(result.status).toBe(200);
    expect((await denied()).approved).toBe(false);
  });
  it("config writes and unknown policy routes cannot replace or disable the separate policy file", async () => {
    const result = await post("/api/config", { policy: { enabled: false, rules: [] } }, "owner-key", "PATCH");
    expect([200, 400]).toContain(result.status);
    expect((await post("/api/policy", { rules: [] }, "owner-key", "PUT")).status).toBe(404);
    expect(readFileSync(file, "utf8")).toBe(bytes);
    expect((await denied()).approved).toBe(false);
    expect((await post("/api/config", { policy: { enabled: false } }, "member-key", "PATCH")).status).toBe(403);
  });
  it("direct file tools refuse policy reads, replacements and parent removal even at full trust", async () => {
    const context = { workingDir: harness.workingDir, sessionId: "s", stepIndex: 0, signal: new AbortController().signal };
    for (const [tool, args] of [
      ["os.fs.read", { path: file }], ["os.fs.write", { path: file, content: "{}" }],
      ["os.fs.move", { from: file, to: join(harness.workingDir, "stolen.json") }], ["os.fs.trash", { paths: [harness.stateDir] }],
    ] as const) await expect(harness.runtime.toolRegistry.invoke(tool, args, context)).rejects.toThrow(/policy.*protected|operator/i);
    expect(readFileSync(file, "utf8")).toBe(bytes);
  });
  it("config set from a tool child cannot disable policy or write a whole-file replacement", async () => {
    vi.stubEnv("ATOMIC_AGENT_TOOL_CHILD", "1");
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(await configCommand(["set", "policy.enabled", "false"])).toBe(1);
    expect(await configCommand(["set", '{"policy":{"enabled":false}}'])).toBe(1);
    expect(readFileSync(file, "utf8")).toBe(bytes);
  });
});
