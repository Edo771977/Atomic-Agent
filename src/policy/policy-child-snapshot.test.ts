import { afterEach, describe, expect, it } from "vitest";
import { join, resolve, relative } from "node:path";
import { tmpdir } from "node:os";
import { loadLocalPolicy } from "./policy-loader.js";
import { installPolicy } from "./policy-active.js";
import { markAgentToolChild } from "../sandbox/command-env.js";
import { evaluatePolicy } from "./policy-evaluator.js";
import { orgPolicyPaths, POLICY_FILE_PINS_ENV } from "../config/org-policy-paths.js";
import { policyFilePaths } from "./policy-paths.js";
import { buildMcpStdioEnv } from "../mcp/mcp-stdio-env.js";

afterEach(() => installPolicy(null));
describe("inherited policy snapshot availability", () => {
  it("validates and parses the same bytes through relative spellings in one load", () => {
    const root = join(tmpdir(), "policy-relative-snapshot"), file = join(root, "policy.json");
    const original = JSON.stringify({ rules: [{ action: "shell", resource: "fixture-a", effect: "deny" }] });
    installPolicy(loadLocalPolicy({ stateDir: root, env: {}, readText: path => path === file ? original : null }));
    const env = markAgentToolChild({}, { ...process.env, ATOMIC_AGENT_STATE_DIR: root });
    const policy = loadLocalPolicy({ stateDir: relative(process.cwd(), root), env,
      readText: path => resolve(path) === file ? path === file ? original : JSON.stringify({ rules: [] }) : null });
    expect(evaluatePolicy(policy, "shell", ["fixture-a"])?.effect).toBe("deny");
  });
  it("retains an intermediate child's stricter context in the next generation", () => {
    const root = join(tmpdir(), "policy-generation-fixture"), child = join(root, "child"), grandchild = join(root, "grandchild");
    const files = new Map([[join(root, "policy.json"), JSON.stringify({ rules: [{ action: "shell", resource: "fixture-a", effect: "ask" }] })],
      [join(child, "policy.json"), JSON.stringify({ rules: [{ action: "shell", resource: "fixture-b", effect: "deny" }] })],
      [join(child, "policy-cache.json"), JSON.stringify({ url: "https://fixture.test/policy", fetchedAt: "fixture", policy: { rules: [{ action: "shell", resource: "fixture-c", effect: "deny" }] } })]]);
    const readText = (path: string) => files.get(resolve(path)) ?? null;
    installPolicy(loadLocalPolicy({ stateDir: root, env: {}, readText }));
    const first = markAgentToolChild({}, { ...process.env, ATOMIC_AGENT_STATE_DIR: root });
    installPolicy(loadLocalPolicy({ stateDir: child, env: first, readText }));
    const second = markAgentToolChild({}, { ...first, ...process.env, ATOMIC_AGENT_STATE_DIR: child });
    const policy = loadLocalPolicy({ stateDir: grandchild, env: second, readText });
    expect(evaluatePolicy(policy, "shell", ["fixture-a"])?.effect).toBe("ask");
    expect(evaluatePolicy(policy, "shell", ["fixture-b"])?.effect).toBe("deny");
    expect(evaluatePolicy(policy, "shell", ["fixture-c"])?.effect).toBe("deny");
    expect(policyFilePaths(policy)).toContain(join(child, "policy-cache.json"));
    expect(orgPolicyPaths(grandchild)).toContain(join(child, "policy-cache.json"));
  });
  it.each([null, JSON.stringify({ rules: [] })])("refuses a missing or changed mandatory snapshot before child bootstrap: %s", replacement => {
    const root = join(tmpdir(), "policy-snapshot-fixture"), file = join(root, "policy.json");
    const raw = JSON.stringify({ rules: [{ action: "shell", resource: "private-synthetic-resource", effect: "deny" }] });
    const read = (path: string) => resolve(path) === resolve(file) ? raw : null;
    installPolicy(loadLocalPolicy({ stateDir: root, env: {}, readText: read }));
    const env = markAgentToolChild({}, { ...process.env, ATOMIC_AGENT_STATE_DIR: root });
    expect(JSON.parse(env[POLICY_FILE_PINS_ENV]!)).toHaveLength(1);
    expect(buildMcpStdioEnv({ [POLICY_FILE_PINS_ENV]: "[]" }, env)[POLICY_FILE_PINS_ENV]).toBe(env[POLICY_FILE_PINS_ENV]);
    expect(JSON.stringify(env)).not.toContain("private-synthetic-resource");
    // Fake filesystem visibility models unavailable mounted state or a
    // changed file. No real mount, link or policy file is manipulated.
    expect(() => loadLocalPolicy({ stateDir: join(root, "child"), env, readText: path => resolve(path) === resolve(file) ? replacement : null })).toThrow(/policy.*snapshot|inherited.*policy/i);
  });
});
