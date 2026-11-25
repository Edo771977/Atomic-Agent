import { afterEach, describe, expect, it, vi } from "vitest";
import type { PathLike } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ApprovalGate } from "../../../approval/approval-gate.js";
import { installPolicy } from "../../../policy/policy-active.js";
import { buildOsFsMoveTool } from "./fs-move.js";
import type { MoveFs } from "./fs-move-plan.js";

afterEach(() => installPolicy(null));

function fixture(effect: "deny" | "ask", folders: readonly string[]) {
  const root = join(tmpdir(), "policy-move-fixture");
  const dest = join(root, "P");
  const sources = new Map(folders.map(name => [join(root, name), true]));
  sources.set(join(root, "ordinary.txt"), false);
  const fs: MoveFs = {
    lstat: vi.fn(async (path: PathLike) => {
      const folder = sources.get(String(path));
      if (folder === undefined) throw Object.assign(new Error("fixture missing entry"), { code: "ENOENT" });
      return { isDirectory: () => folder, isFile: () => !folder, isSymbolicLink: () => false } as never;
    }) as MoveFs["lstat"],
    realpath: vi.fn(async (path: PathLike) => String(path)) as unknown as MoveFs["realpath"],
    rename: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined) as MoveFs["mkdir"],
    cp: vi.fn(async () => undefined),
    rm: vi.fn(async () => undefined),
  };
  installPolicy({ sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0,
    action: "edit", resource: `${dest.replace(/\\/g, "/")}/*.txt`, effect }] });
  const gate = new ApprovalGate({ level: 5, emit: () => { throw new Error("no invisible prompt"); } });
  gate.setSessionPolicy("fixture", { onPrompt: "refuse", reason: "fixture operator decision required" });
  return { fs, tool: buildOsFsMoveTool({ approvals: gate, approvalRequired: false }, { fs }),
    ctx: { workingDir: root, sessionId: "fixture", stepIndex: 0, signal: new AbortController().signal } };
}

describe("policy decisions for new directory move destinations", () => {
  it.each(["deny", "ask"] as const)("retains %s for possible descendants before the fake rename", async effect => {
    const { tool, fs, ctx } = fixture(effect, ["folder"]);
    await expect(tool.run({ from: "folder", to: "P" }, ctx)).rejects.toThrow(/policy|fixture operator/);
    expect(fs.rename).not.toHaveBeenCalled();
  });
  it.each(["deny", "ask"] as const)("keeps an ordinary file move outside the descendant %s pattern", async effect => {
    const { tool, fs, ctx } = fixture(effect, []);
    expect((await tool.run({ from: "ordinary.txt", to: "P" }, ctx)).status).toBe("ok");
    expect(fs.rename).toHaveBeenCalledOnce();
  });
  it("checks a later directory destination before the first fake mutation in a batch", async () => {
    const { tool, fs, ctx } = fixture("deny", ["folder"]);
    await expect(tool.run({ moves: [{ from: "ordinary.txt", to: "other.txt" }, { from: "folder", to: "P" }] }, ctx)).rejects.toThrow(/policy/);
    expect(fs.rename).not.toHaveBeenCalled();
  });
});
