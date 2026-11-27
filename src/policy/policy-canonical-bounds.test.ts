import { describe, expect, it } from "vitest";
import { join, parse, resolve } from "node:path";
import { tmpdir } from "node:os";
import { canonicalPolicyPath } from "./policy-paths.js";

describe("bounded canonical policy identity", () => {
  const root = join(tmpdir(), "canonical-fixture");
  const missing = () => { throw Object.assign(new Error("fixture missing"), { code: "ENOENT" }); };
  it("resolves a link to a final path that is not created yet using a fake filesystem", () => {
    const link = join(root, "alias"), final = join(root, "future", "policy.json");
    const fs = { realpath: (path: string) => path === parse(root).root ? path : missing(),
      lstat: (path: string) => path === link ? { isSymbolicLink: () => true } : missing(), readlink: () => final };
    expect(canonicalPolicyPath(link, fs)).toBe(resolve(final));
    expect(canonicalPolicyPath(join(link, "child"), fs)).toBe(resolve(final, "child"));
  });
  it("refuses indeterminate link cycles and excessive missing depth without recursion", () => {
    let calls = 0;
    const fs = { realpath: missing, lstat: () => ({ isSymbolicLink: () => true }), readlink: () => { calls++; return "alias"; } };
    expect(() => canonicalPolicyPath(join(root, "alias"), fs)).toThrow(/canonical|resolve|limit/i);
    expect(calls).toBeLessThanOrEqual(256);
    expect(() => canonicalPolicyPath(join(root, ...Array.from({ length: 1000 }, () => "missing")))).toThrow(/canonical|resolve|limit/i);
  });
});
