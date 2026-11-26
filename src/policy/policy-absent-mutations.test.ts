import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { policyCallRefusal } from "./policy-enforce.js";
import { checkPolicyMutation } from "./policy-mutations.js";
import { policyFileReadFilter, policyMayIntersectTree } from "./policy-paths.js";
import type { EffectivePolicy } from "./policy-evaluator.js";

describe("definitely absent policy files preserve ordinary ancestor operations", () => {
  it("preserves archive, glob, permission and dotfiles Git plans without weakening an existing policy", () => {
    const root = mkdtempSync(join(tmpdir(), "policy-absent-"));
    const file = join(root, "policy.json");
    const policy: EffectivePolicy = { rules: [], mcpAllowlists: [], sources: [{ kind: "user", location: file, state: "missing" }] };
    try {
      for (const tool of ["os.fs.archive.create", "os.fs.permissions", "os.git.add", "os.git.commit", "os.git.pull"]) {
        expect(checkPolicyMutation(policy, tool, [root], root).refusal, tool).toBeNull();
      }
      expect(policyMayIntersectTree(policy, root)).toBe(false);
      expect(policyFileReadFilter(policy).allows(join(root, "ordinary.txt"))).toBe(true);
      expect(policyCallRefusal(policy, "os.shell.run", { cmd: "chmod", args: ["700", root] }, root)).toBeNull();
      expect(policyCallRefusal(policy, "os.fs.write", { path: file }, root)).toContain("protected");
      writeFileSync(file, "{}");
      expect(checkPolicyMutation(policy, "os.fs.permissions", [root], root).refusal).toContain("protected");
      expect(policyMayIntersectTree(policy, root)).toBe(true);
      expect(policyFileReadFilter(policy).allows(file)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
