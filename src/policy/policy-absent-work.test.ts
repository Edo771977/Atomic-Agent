import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as paths from "./policy-paths.js";
import { checkPolicyMutation } from "./policy-mutations.js";
import type { EffectivePolicy } from "./policy-evaluator.js";

afterEach(() => vi.restoreAllMocks());
describe("no canonical policy scan for certainly absent files", () => {
  it("does not canonicalize a Git tree when every protected entry is absent", () => {
    const root = join(tmpdir(), "policy-no-files-fixture");
    const policy: EffectivePolicy = { rules: [], mcpAllowlists: [], sources: [{ kind: "user", state: "missing", location: join(root, "policy.json") }] };
    const canonical = vi.fn(() => { throw new Error("unnecessary tree scan"); });
    expect(paths.policyMayIntersectTree(policy, root, canonical, () => false)).toBe(false);
    expect(canonical).not.toHaveBeenCalled();
  });
  it("keeps mutation plans lexical when no source or file is loaded, while retaining reserved names", () => {
    const root = mkdtempSync(join(tmpdir(), "policy-no-plan-scan-"));
    const policy: EffectivePolicy = { rules: [], mcpAllowlists: [], sources: [{ kind: "user", state: "missing", location: join(root, "policy.json") }] };
    const original = paths.createEditPathNormalizer;
    const canonical = vi.fn((path: string) => path);
    vi.spyOn(paths, "createEditPathNormalizer").mockImplementation((cwd, platform) => original(cwd, platform, canonical));
    try {
      expect(checkPolicyMutation(policy, "os.fs.write", [join(root, "ordinary.txt")], root)).toEqual({ refusal: null, ask: false });
      expect(canonical).not.toHaveBeenCalled();
      expect(checkPolicyMutation(policy, "os.fs.write", [join(root, "policy.json")], root).refusal).toContain("protected");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
