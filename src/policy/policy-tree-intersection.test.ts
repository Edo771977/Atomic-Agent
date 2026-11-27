import { describe, expect, it } from "vitest";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { policyMayIntersectTree } from "./policy-paths.js";
import type { EffectivePolicy } from "./policy-evaluator.js";

describe("protected policy entries in a Git mutation tree", () => {
  it("refuses an indeterminate ancestor chain beyond the per-call depth limit", () => {
    const root = join(tmpdir(), "unrelated-policy-tree-fixture");
    const file = join(tmpdir(), ...Array.from({ length: 300 }, () => "nested"), "policy.json");
    const policy: EffectivePolicy = { rules: [], mcpAllowlists: [], sources: [{ kind: "system", location: file, state: "loaded" }] };
    let scans = 0;
    expect(() => policyMayIntersectTree(policy, root, path => { scans++; return path; }, () => true)).toThrow(/limit/i);
    expect(scans).toBeLessThanOrEqual(260);
  });
  it("retains the entry of a policy symlink whose fake canonical target is outside the tree", () => {
    const root = join(tmpdir(), "policy-tree-fixture");
    const file = join(root, "policy.json");
    const policy: EffectivePolicy = { rules: [], mcpAllowlists: [], sources: [{ kind: "system", location: file, state: "loaded" }] };
    expect(policyMayIntersectTree(policy, root, path => path === file ? join(tmpdir(), "outside", "policy.json") : path, () => true)).toBe(true);
  });
  it("finds a containing directory entry through a fake outer alias", () => {
    const root = join(tmpdir(), "policy-tree-fixture");
    const alias = join(tmpdir(), "outer-alias");
    const file = join(alias, "linked-directory", "policy.json");
    const policy: EffectivePolicy = { rules: [], mcpAllowlists: [], sources: [{ kind: "system", location: file, state: "loaded" }] };
    const canonical = (path: string) => path === alias ? root : path === dirname(file) || path === file ? join(tmpdir(), "outside", "policy.json") : path;
    expect(policyMayIntersectTree(policy, root, canonical, () => true)).toBe(true);
  });
  it("does not require a checkout plan for unrelated protected policy paths", () => {
    const root = join(tmpdir(), "policy-tree-fixture");
    const policy: EffectivePolicy = { rules: [], mcpAllowlists: [], sources: [{ kind: "system", location: join(tmpdir(), "elsewhere", "policy.json"), state: "missing" }] };
    expect(policyMayIntersectTree(policy, root, path => path)).toBe(false);
  });
});
