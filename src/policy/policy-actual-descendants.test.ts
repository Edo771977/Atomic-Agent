import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPolicyMutation } from "./policy-mutations.js";
import type { EffectivePolicy } from "./policy-evaluator.js";

const roots: string[] = [];
vi.mock("node:fs", async importOriginal => { const actual = await importOriginal<typeof import("node:fs")>(); return { ...actual, readdirSync: vi.fn(actual.readdirSync) }; });
afterEach(() => { vi.mocked(readdirSync).mockClear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe("actual directory mutation descendants", () => {
  it("holds a synthetic tree beyond the inspection budget", () => {
    const root = mkdtempSync(join(tmpdir(), "policy-descendant-budget-")); roots.push(root);
    vi.mocked(readdirSync).mockReturnValueOnce(Array.from({ length: 4097 }, (_, i) => ({ name: `${i}.md`, isDirectory: () => false })) as never);
    const policy: EffectivePolicy = { sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "edit", resource: `${root.replace(/\\/g, "/")}/*.txt`, effect: "deny" }] };
    expect(checkPolicyMutation(policy, "os.fs.trash", [root], root).refusal).not.toBeNull();
  });
  it.each(["os.fs.move", "os.fs.trash"])("permits ordinary descendants and restricts real glob matches for %s", tool => {
    const root = mkdtempSync(join(tmpdir(), "policy-descendants-")); roots.push(root);
    const source = join(root, "source"); mkdirSync(source); writeFileSync(join(source, "ordinary.md"), "fixture");
    for (const effect of ["deny", "ask"] as const) {
      const policy: EffectivePolicy = { sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "edit", resource: `${source.replace(/\\/g, "/")}/*.txt`, effect }] };
      expect(checkPolicyMutation(policy, tool, [source], root)).toEqual({ refusal: null, ask: false });
      writeFileSync(join(source, "blocked.txt"), "fixture");
      const decision = checkPolicyMutation(policy, tool, [source], root);
      expect(effect === "deny" ? decision.refusal !== null : decision.ask).toBe(true);
      rmSync(join(source, "blocked.txt"));
    }
  });
  it("maps source descendants to a not-yet-created move destination", () => {
    const root = mkdtempSync(join(tmpdir(), "policy-move-descendants-")); roots.push(root);
    const source = join(root, "source"), destination = join(root, "destination"); mkdirSync(source); writeFileSync(join(source, "ordinary.md"), "fixture");
    const policy: EffectivePolicy = { sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "edit", resource: `${destination.replace(/\\/g, "/")}/*.txt`, effect: "deny" }] };
    expect(checkPolicyMutation(policy, "os.fs.move", [source, destination], root, [source, destination], [{ from: source, to: destination }])).toEqual({ refusal: null, ask: false });
    writeFileSync(join(source, "blocked.txt"), "fixture");
    expect(checkPolicyMutation(policy, "os.fs.move", [source, destination], root, [source, destination], [{ from: source, to: destination }]).refusal).not.toBeNull();
  });
});
