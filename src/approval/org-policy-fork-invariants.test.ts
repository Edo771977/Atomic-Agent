import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { ApprovalGate, type ApprovalRequest } from "./approval-gate.js";
import { ApprovalRouter } from "./approval-router.js";
import { installPolicy } from "../policy/policy-active.js";
import { mergePolicySources } from "../policy/policy-loader.js";
import { policyRuleMatch } from "../policy/policy-enforce.js";
import { parsePolicyFile, POLICY_ACTIONS } from "../policy/policy-schema.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { createEgressGuard } from "../tools/tool-egress.js";
import { makeProviderPolicy } from "../config/project-constraint-match.js";
import { requireUrlSendApproval } from "../tools/os/web/url-data-guard.js";
import { refuseInIncognito } from "../tools/memory/incognito-guard.js";
import { PrivacyVault } from "../privacy/privacy-vault.js";
import { canReadSession } from "../http/serve-egress.js";
import { roleHasScope } from "../http/http-scopes.js";
import { createEmptySessionState } from "../session/session-state.js";
import { getStateSecretPaths } from "../config/config-file.js";
import { buildOsSandboxPolicy } from "../sandbox/os-sandbox.js";

const org = (effect: "allow" | "ask" | "deny") => mergePolicySources([{ status: { kind: "system", location: "fixture", state: "loaded" },
  file: parsePolicyFile({ rules: POLICY_ACTIONS.map(action => ({ action, resource: "*", effect })) }) }]);
const ctx = () => ({ sessionId: "s", workingDir: process.cwd(), stepIndex: 0, signal: new AbortController().signal });
afterEach(() => installPolicy(null));

describe("organization allow preserves fork restrictions", () => {
  it.each(["shell", "http_write", "trust_config", "state_secret"] as const)("does not grant %s at level 1", async category => {
    const p = org("allow"); installPolicy(p);
    const emit = vi.fn(); const gate = new ApprovalGate({ level: 1, emit });
    gate.setOrgPolicy(request => policyRuleMatch(p, request));
    const answer = gate.request({ sessionId: "s", tool: "os.shell.run", category, reason: "fixture", commandArgv: ["node", "test.js"] });
    expect(emit).toHaveBeenCalledOnce();
    gate.resolve({ approvalId: (emit.mock.calls[0]![0] as ApprovalRequest).approvalId, approved: false });
    expect((await answer).approved).toBe(false);
  });
  it("leaves per-folder egress denial before execution", async () => {
    installPolicy(org("allow"));
    const run = vi.fn();
    const guard = createEgressGuard({ policyForSession: () => makeProviderPolicy({ key: process.cwd(), matchedDir: process.cwd(), allowedProviders: ["local-llama"], allowedEgress: [] }), mcpEgress: () => null });
    const registry = new ToolRegistry({ dispatchGuard: guard });
    registry.register({ name: "os.web.fetch", description: "fixture", readonly: true, run });
    await expect(registry.invoke("os.web.fetch", { url: "https://example.com" }, ctx())).rejects.toThrow(/egress|restricted|allowed/i);
    expect(run).not.toHaveBeenCalled();
  });
  it("does not silence the data-bearing URL approval", async () => {
    const p = org("allow"); installPolicy(p);
    const gate = new ApprovalGate({ level: 1, emit: () => { throw new Error("worker cannot prompt"); } });
    gate.setOrgPolicy(request => policyRuleMatch(p, request)); gate.setSessionPolicy("s", { onPrompt: "refuse", reason: "worker cannot approve data egress" });
    await expect(requireUrlSendApproval({ approvalRequired: true, approvals: gate }, { mode: "data", tool: "os.web.fetch", url: `https://example.com/?data=${"x".repeat(500)}`, sessionId: "s", signal: ctx().signal })).rejects.toThrow(/worker cannot approve/);
  });
  it("keeps incognito memory refusals and output privacy", async () => {
    installPolicy(org("allow")); const run = vi.fn();
    const registry = new ToolRegistry();
    registry.register(refuseInIncognito({ name: "memory.notes.store", description: "fixture", readonly: false, run }));
    const answer = await registry.invoke("memory.notes.store", { text: "private" }, { ...ctx(), incognito: true });
    expect(answer.status).toBe("error"); expect(run).not.toHaveBeenCalled();
  });
  it("does not disable Privacy Shield masking", () => {
    installPolicy(org("allow")); const vault = new PrivacyVault();
    expect(vault.mask("jane@example.com")).toBe("[EMAIL_1]");
  });
  it.each(["viewer", "member", "operator", "admin"] as const)("keeps incognito hidden from named %s tokens", role => {
    installPolicy(org("allow"));
    const state = createEmptySessionState({ id: "private", workingDir: process.cwd() });
    state.incognito = { since: 1, owner: "fixture" };
    expect(canReadSession({ caller: { name: "named", role }, runtime: {} } as never, state)).toBe(false);
    if (role !== "admin") expect(roleHasScope(role, "admin")).toBe(false);
  });
  it("passes policy and cache into the existing OS state protection", () => {
    installPolicy(org("allow")); const stateDir = join(process.cwd(), "state-fixture");
    const paths = getStateSecretPaths({ stateDir, userConfigFile: join(stateDir, "config.json"), localModelsDataDir: join(stateDir, "models") });
    const sandbox = buildOsSandboxPolicy({ workspaceRoots: [process.cwd()], stateDir, protectedPaths: paths, network: false });
    expect(paths).toContain(join(stateDir, "policy.json")); expect(paths).toContain(join(stateDir, "policy-cache.json"));
    expect(sandbox.denyRead).toContain(stateDir); expect(sandbox.network).toBe(false);
  });
});

describe("all approval surfaces share the policy refusal boundary", () => {
  it.each(["TUI", "HTTP", "Telegram", "Slack", "Discord", "Matrix", "Signal", "Teams", "Google Chat"])("a %s handler cannot turn a policy denial into an approval or saved grant", async surface => {
    const handler = vi.fn((request: ApprovalRequest) => gate.resolve({ approvalId: request.approvalId, approved: true, grant: "always" }));
    const router = new ApprovalRouter(handler); router.setForSession(surface, handler);
    const gate = new ApprovalGate({ level: 5, emit: request => router.emit(request) });
    gate.setOrgPolicy(request => policyRuleMatch(org("deny"), request));
    expect((await gate.request({ sessionId: surface, tool: "os.shell.run", category: "shell", reason: "fixture", commandArgv: ["node", "test.js"] })).approved).toBe(false);
    expect(handler).not.toHaveBeenCalled(); expect(gate.pendingCount()).toBe(0);
  });
});
