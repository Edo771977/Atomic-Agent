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
import { policyFileReadFilter } from "./policy-paths.js";
import { osFsDiffTool } from "../tools/os/fs/fs-diff.js";
import { buildOsCodeSearchTool } from "../tools/os/code/code-search.js";

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
  it("diff refuses protected inputs before reading either side", async () => {
    await expect(osFsDiffTool.run({ aPath: file, bText: "ordinary" }, ctx())).rejects.toThrow(/policy.*protected/i);
    expect((await osFsDiffTool.run({ aPath: join(root, "ordinary.ts"), bText: "ordinary" }, ctx())).status).toBe("ok");
  });
  it("code.search supplies exclusions to its fake adapter and filters returned protected matches", async () => {
    const runCommand = vi.fn<typeof import("../sandbox/command-runner.js").runCommand>(async () => ({ command: "fake-sg", args: [], exitCode: 0, signal: null, stdout: JSON.stringify([file, join(root, "ordinary.ts")].map(file => ({ file, text: "Fixture", lines: "Fixture", range: { byteOffset: { start: 0, end: 7 }, start: { line: 0, column: 0 }, end: { line: 0, column: 7 } } }))), stderr: "", durationMs: 0, timedOut: false, truncated: false, inputTruncated: false }));
    const tool = buildOsCodeSearchTool({ resolveAstGrepPath: () => "fake-sg", neutralConfig: async () => join(root, "neutral.yml"), runCommand });
    const result = await tool.run({ pattern: "Fixture", path: root }, ctx());
    expect(runCommand.mock.calls[0]?.[1]).toContain("!state/policy.ts");
    expect(result.summary).not.toContain("policy.ts");
    expect(result.summary).toContain("ordinary.ts");
    await expect(tool.run({ pattern: "Fixture", path: file }, ctx())).rejects.toThrow(/policy.*protected/i);
    expect(runCommand).toHaveBeenCalledTimes(1);
  });
  it("grep supplies exact protected-file exclusions to its fake transport", async () => {
    const runCommand = vi.fn<typeof import("../sandbox/command-runner.js").runCommand>(async () => ({ command: "rg", args: [], exitCode: 1, signal: null, stdout: "", stderr: "", durationMs: 0, timedOut: false, truncated: false, inputTruncated: false }));
    await buildOsFsGrepTool({ resolveRgPath: () => "fake-rg", runCommand }).run({ pattern: "Fixture", path: root }, ctx());
    expect(runCommand.mock.calls[0]?.[1]).toContain("!state/policy.ts");
  });
  it("a direct grep of the exact protected file refuses before its fake child", async () => {
    const runCommand = vi.fn<typeof import("../sandbox/command-runner.js").runCommand>(async () => ({ command: "rg", args: [], exitCode: 1, signal: null, stdout: "", stderr: "", durationMs: 0, timedOut: false, truncated: false, inputTruncated: false }));
    await expect(buildOsFsGrepTool({ resolveRgPath: () => "fake-rg", runCommand }).run({ pattern: "ordinary", path: file }, ctx())).rejects.toThrow(/policy.*protected/);
    expect(runCommand).not.toHaveBeenCalled();
  });
  it("code-map excludes protected files before reading source", async () => {
    const result = await buildOsFsCodeMapTool({ backend: async () => regexOutlineBackend }).run({ path: root }, ctx());
    expect(result.summary).toContain("ordinaryFixture"); expect(result.summary).not.toContain("privatePolicyFixture");
  });
  it("a fake canonical root alias yields exact recursive-reader exclusions", () => {
    const alias = join(tmpdir(), "policy-alias-fixture");
    const real = join(tmpdir(), "policy-real-fixture");
    const policy: EffectivePolicy = { rules: [], mcpAllowlists: [], sources: [{ kind: "user", state: "missing", location: join(real, "State", "policy.json") }] };
    const filter = policyFileReadFilter(policy, path => path.replace("policy-alias-fixture", "policy-real-fixture"));
    expect(filter.allows(join(alias, "State", "policy.json"))).toBe(false);
    expect(filter.exclusions(alias)).toContain("State/policy.json");
  });
});
