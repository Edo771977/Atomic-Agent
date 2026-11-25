import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { installPolicy } from "./policy-active.js";
import { policyCallRefusal } from "./policy-enforce.js";
import type { EffectivePolicy } from "./policy-evaluator.js";
import { buildOsFsGlobTool } from "../tools/os/fs/fs-glob.js";
import { buildOsFsGrepTool } from "../tools/os/fs/fs-grep.js";
import { buildOsFsCodeMapTool } from "../tools/os/code-map/code-map-tool.js";
import { regexOutlineBackend } from "../tools/os/code-map/regex-outline.js";

describe("policy file read boundary", () => {
  let root: string, file: string, policy: EffectivePolicy;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "policy-read-"));
    mkdirSync(join(root, "state")); file = join(root, "state", "policy.ts");
    writeFileSync(file, "export const privatePolicyFixture = 1;\n");
    writeFileSync(join(root, "ordinary.ts"), "export const ordinaryFixture = 1;\n");
    policy = { rules: [], mcpAllowlists: [], sources: [{ kind: "user", location: file, state: "missing" },
      { kind: "system", location: join(parse(root).root, "etc", "atomic-agent", "policy.json"), state: "missing" }] };
    installPolicy(policy);
  });
  afterEach(() => { installPolicy(null); rmSync(root, { recursive: true, force: true }); });
  const ctx = () => ({ workingDir: root, sessionId: "fixture", stepIndex: 0, signal: new AbortController().signal });
  it.each(["os.fs.list", "os.fs.grep", "os.fs.glob", "os.fs.code_map"])("ordinary ancestor reads remain available for %s with no rules", tool => {
    for (const path of [root, dirname(file), parse(root).root, join(parse(root).root, "etc")]) {
      expect(policyCallRefusal(policy, tool, { path, cwd: path }, root)).toBeNull();
    }
  });
  it("point reads stay exact while mutations protect ancestors", () => {
    expect(policyCallRefusal(policy, "os.fs.read", { path: file }, root)).toContain("protected");
    expect(policyCallRefusal(policy, "os.fs.read", { path: join(root, "ordinary.ts") }, root)).toBeNull();
    expect(policyCallRefusal(policy, "os.fs.trash", { paths: [root] }, root)).toContain("protected");
  });
  it("glob omits only policy files while retaining ordinary descendants", async () => {
    const result = await buildOsFsGlobTool().run({ pattern: ["**/*.ts"], cwd: root }, ctx());
    expect(result.summary).toContain("ordinary.ts"); expect(result.summary).not.toContain("policy.ts");
  });
  it("grep supplies exact protected-file exclusions to its fake transport", async () => {
    const runCommand = vi.fn<typeof import("../sandbox/command-runner.js").runCommand>(async () => ({ command: "rg", args: [], exitCode: 1, signal: null, stdout: "", stderr: "", durationMs: 0, timedOut: false, truncated: false, inputTruncated: false }));
    await buildOsFsGrepTool({ resolveRgPath: () => "fake-rg", runCommand }).run({ pattern: "Fixture", path: root }, ctx());
    expect(runCommand.mock.calls[0]?.[1]).toContain("!state/policy.ts");
  });
  it("code-map excludes protected files before reading source", async () => {
    const result = await buildOsFsCodeMapTool({ backend: async () => regexOutlineBackend }).run({ path: root }, ctx());
    expect(result.summary).toContain("ordinaryFixture"); expect(result.summary).not.toContain("privatePolicyFixture");
  });
});
