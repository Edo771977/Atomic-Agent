import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installPolicy } from "./policy-active.js";
import { policyCallRefusal, policyRuleMatch } from "./policy-enforce.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { buildOsFsPatchTool } from "../tools/os/fs/fs-patch.js";
import { ApprovalGate } from "../approval/approval-gate.js";
import type { EffectivePolicy } from "./policy-evaluator.js";
import { buildOsGitCheckoutTool } from "../tools/os/git/git-checkout.js";
import * as runner from "../tools/os/git/git-runner.js";
import * as probe from "../tools/os/git/git-repo-probe.js";

const root = join(tmpdir(), "ordinary-home-fixture");
const state = join(root, ".atomic-agent");
const policy: EffectivePolicy = { rules: [], mcpAllowlists: [], sources: [{ kind: "user", state: "missing", location: join(state, "policy.json") }] };
afterEach(() => { installPolicy(null); vi.restoreAllMocks(); });
describe("ordinary work without organization rules", () => {
  it("approves an ordinary Git plan even if broader trust metadata names a policy ancestor", async () => {
    installPolicy(policy);
    vi.spyOn(probe, "resolveGitToplevel").mockResolvedValue({ ok: true, root });
    const run = vi.spyOn(runner, "runGit").mockImplementation(async options => ({ exitCode: 0, stdout: options.args[0] === "diff" ? "ordinary.txt\0" : "", stderr: "", timedOut: false, truncated: false, args: options.args, repoRoot: root } as never));
    const gate = new ApprovalGate({ level: 5, emit: () => { throw new Error("unexpected prompt"); } }); gate.setOrgPolicy(request => policyRuleMatch(policy, request));
    const result = await buildOsGitCheckoutTool({ approvals: gate, approvalRequired: true, trustConfigPaths: [join(state, "config.json")] }).run({ branch: "ordinary" }, { workingDir: root, sessionId: "fixture", stepIndex: 0, signal: new AbortController().signal });
    expect(result.status).toBe("ok");
    expect(run.mock.calls.some(([options]) => options.args[0] === "diff")).toBe(true);
  });
  it("dispatches patches using their real diff targets rather than the working directory", async () => {
    installPolicy(policy);
    const registry = new ToolRegistry();
    registry.register(buildOsFsPatchTool({ approvals: new ApprovalGate({ level: 5, emit: () => undefined }), approvalRequired: false }));
    const result = await registry.invoke("os.fs.patch", { patch: "*** Begin Patch\n*** Add File: ordinary.txt\n+fixture\n*** End Patch", rootDir: root }, { workingDir: root, sessionId: "fixture", stepIndex: 0, signal: new AbortController().signal });
    expect(result.status).toBe("ok");
  });
  it("leaves state directory reads to the fork's state_secret approval", () => {
    expect(policyCallRefusal(policy, "os.shell.run", { cmd: "cat", args: [state] }, root)).toBeNull();
    expect(policyRuleMatch(policy, { tool: "os.fs.grep", category: "state_secret", affectedResources: [state], workdir: root })).toBeNull();
    expect(policyCallRefusal(policy, "os.shell.run", { cmd: "rm", args: ["-rf", state] }, root)).toContain("protected");
  });
  it("uses trust_config ancestors only for actual targetPaths", () => {
    expect(policyRuleMatch(policy, { tool: "os.git.checkout", category: "trust_config", affectedResources: [root], workdir: root })).toBeNull();
    expect(policyRuleMatch(policy, { tool: "os.fs.move", category: "trust_config", targetPaths: [state], workdir: root })?.decision).toBe("deny");
  });
});
