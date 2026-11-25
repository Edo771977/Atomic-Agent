import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { policyCallRefusal, policyRuleMatch } from "./policy-enforce.js";
import { gateRequestTarget } from "./policy-targets.js";
import type { EffectivePolicy } from "./policy-evaluator.js";
import { createEditPathNormalizer } from "./policy-paths.js";
import { globMatches } from "./policy-glob.js";

describe("common edit path identity", () => {
  it.each(["win32", "darwin"] as const)("canonicalizes both sides and folds case on %s using a fake filesystem adapter", platform => {
    const root = platform === "win32" ? "C:/Repo" : "/Work";
    const normal = createEditPathNormalizer(root, platform, path => path.replace(/alias/gi, "real"));
    const pattern = normal.pattern("Alias/*.TXT");
    const resource = normal.path(platform === "win32" ? "c:\\REPO\\REAL\\BLOCKED.txt" : "/WORK/REAL/BLOCKED.txt");
    expect(globMatches(pattern, resource)).toBe(true);
    expect(resource).toBe(platform === "win32" ? "c:/repo/real/blocked.txt" : "/work/real/blocked.txt");
  });
  it("gate and dispatch use the same explicit working directory and separators", () => {
    const workdir = join(tmpdir(), "policy-path-fixture");
    const absolute = join(workdir, "src", "blocked.txt");
    const policy: EffectivePolicy = { sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "edit", resource: absolute.replace(/\\/g, "/"), effect: "deny" }] };
    expect(policyRuleMatch(policy, { tool: "os.fs.write", category: "fs_write_workspace", targetPaths: ["src/blocked.txt"], workdir } as Parameters<typeof policyRuleMatch>[1])?.decision).toBe("deny");
    expect(policyCallRefusal(policy, "os.fs.write", { path: "src/blocked.txt" }, workdir)).toContain("policy");
    expect(gateRequestTarget({ tool: "os.fs.write", category: "fs_write_workspace", targetPaths: ["src/blocked.txt"], workdir } as Parameters<typeof gateRequestTarget>[0])?.resources).toContain(absolute.replace(/\\/g, "/").toLowerCase());
  });
  it("relative patterns match an absolute actual file in both paths", () => {
    const workdir = join(tmpdir(), "policy-path-fixture");
    const policy: EffectivePolicy = { sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "edit", resource: "src/*.txt", effect: "deny" }] };
    const targetPaths = [join(workdir, "src", "blocked.txt")];
    expect(policyRuleMatch(policy, { tool: "os.fs.write", category: "fs_write_workspace", targetPaths, workdir } as Parameters<typeof policyRuleMatch>[1])?.decision).toBe("deny");
    expect(policyCallRefusal(policy, "os.fs.write", { path: targetPaths[0] }, workdir)).toContain("policy");
  });
});
