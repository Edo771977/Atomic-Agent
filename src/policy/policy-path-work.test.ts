import { describe, expect, it, vi } from "vitest";
import { join, parse } from "node:path";
import { tmpdir } from "node:os";
import { createPolicyCanonicalizer } from "./policy-paths.js";
import { checkPolicyMutation } from "./policy-mutations.js";
import * as fs from "node:fs";
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, statSync: vi.fn(actual.statSync), realpathSync: vi.fn(actual.realpathSync) };
});

describe("policy path work per evaluation", () => {
  it("shares missing-parent scans only inside one evaluation", () => {
    const root = join(tmpdir(), "missing-policy-fixture");
    const realpath = vi.fn((path: string) => { if (path === parse(root).root) return path; throw Object.assign(new Error("missing"), { code: "ENOENT" }); });
    const adapter = { realpath, lstat: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); }, readlink: () => "" };
    const canonical = createPolicyCanonicalizer(adapter);
    canonical(join(root, "a")); canonical(join(root, "b"));
    expect(realpath.mock.calls.filter(([path]) => path === root)).toHaveLength(1);
    createPolicyCanonicalizer(adapter)(join(root, "c"));
    expect(realpath.mock.calls.filter(([path]) => path === root)).toHaveLength(2);
  });
  it("does no filesystem scans for an empty policy mutation plan", () => {
    const stat = vi.mocked(fs.statSync).mockClear();
    const realpath = vi.mocked(fs.realpathSync).mockClear();
    try {
      const start = performance.now();
      const paths = Array.from({ length: 1000 }, (_, i) => join(tmpdir(), "ordinary-fixture", `${i}.txt`));
      expect(checkPolicyMutation({ rules: [], sources: [], mcpAllowlists: [] }, "fixture.write", paths, tmpdir())).toEqual({ refusal: null, ask: false });
      expect(stat).not.toHaveBeenCalled(); expect(realpath).not.toHaveBeenCalled();
      expect(performance.now() - start).toBeLessThan(50);
    } finally { stat.mockClear(); realpath.mockClear(); }
  });
});
