import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runWithProviderPolicy } from "../llm/provider-policy.js";
import { createSessionReadTaint } from "./session-read-taint.js";

/**
 * Issue #74 item 2: a copy of a constrained folder in the temp directory
 * (a fusion branch workspace, a verify copy) or the spill folder of a
 * constrained session carries the source's policy. The temp root's
 * marker (`.atag-source.json`) names the source; a recognised root with
 * no readable marker fails closed.
 */
describe("read taint of temp copies", () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    const root = mkdtempSync(join(tmpdir(), "pc-temp-copy-"));
    made.push(root);
    const secret = join(root, "secret");
    const open = join(root, "open");
    for (const dir of [secret, open]) mkdirSync(dir, { recursive: true });
    const config = { projects: { roots: [], constraints: { [secret]: { allowedProviders: ["local-llama"] } } } };
    const taint = createSessionReadTaint({ readConfig: () => config });
    const ctx = (sessionId: string) => ({ sessionId, workingDir: open });
    return { secret, open, taint, ctx };
  }

  const fusionRoot = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "atag-fusion-a1b2c3-"));
    made.push(dir);
    mkdirSync(join(dir, "base"), { recursive: true });
    return dir;
  };

  it("a read inside a fusion copy of a constrained folder taints with that folder's policy", () => {
    const t = setup();
    const copy = fusionRoot();
    writeFileSync(join(copy, ".atag-source.json"), JSON.stringify({ version: 1, kind: "fusion", source: t.secret }), { mode: 0o600 });
    const applied = runWithProviderPolicy(undefined, () =>
      t.taint.noteDispatch("os.fs.read", { path: join(copy, "base", "plan.md") }, t.ctx("s-copy")));
    expect(applied?.key).toBe(t.secret);
    expect(applied?.allowedProviders).toEqual(["local-llama"]);
  });

  it("the copy's stamped policy is intersected with the source folder's", () => {
    const t = setup();
    const copy = fusionRoot();
    const stamp = { key: "/elsewhere/finance", allowedProviders: [], allowedEgress: [], matchedDir: "/elsewhere/finance" };
    writeFileSync(join(copy, ".atag-source.json"), JSON.stringify({ version: 1, kind: "fusion", source: t.secret, policy: stamp }), { mode: 0o600 });
    const applied = runWithProviderPolicy(undefined, () =>
      t.taint.noteDispatch("os.shell.run", { cmd: "cat", args: [join(copy, "base", "a.txt")] }, t.ctx("s-stamp")));
    expect(applied?.allowedProviders).toEqual([]);
    expect(applied?.key).toContain(t.secret);
    expect(applied?.key).toContain("/elsewhere/finance");
  });

  it("a recognised temp root with no readable marker fails closed: nothing may serve the session", () => {
    const t = setup();
    const missing = fusionRoot();
    const broken = fusionRoot();
    writeFileSync(join(broken, ".atag-source.json"), "{not json", { mode: 0o600 });
    for (const copy of [missing, broken]) {
      const applied = runWithProviderPolicy(undefined, () =>
        t.taint.noteDispatch("os.fs.read", { path: join(copy, "base", "x") }, t.ctx(`s-${copy.length}`)));
      expect(applied?.allowedProviders, copy).toEqual([]);
    }
  });

  it("another constrained session's spill folder taints with that session's stamped policy; one's own does not", () => {
    const t = setup();
    const other = `s-spill-other-${process.pid}-${Date.now()}`;
    const dir = join(tmpdir(), "atomic-agent-tool-outputs", other);
    mkdirSync(dir, { recursive: true });
    made.push(dir);
    const stamp = { key: t.secret, allowedProviders: ["local-llama"], allowedEgress: [], matchedDir: t.secret };
    writeFileSync(join(dir, ".atag-source.json"), JSON.stringify({ version: 1, kind: "spill", sessionId: other, policy: stamp }), { mode: 0o600 });
    writeFileSync(join(dir, "0001-abcdef-os-shell-run.txt"), "secret output");
    const applied = runWithProviderPolicy(undefined, () =>
      t.taint.noteDispatch("os.fs.read", { path: join(dir, "0001-abcdef-os-shell-run.txt") }, t.ctx("s-reader")));
    expect(applied?.key).toBe(t.secret);
    // The session's own outputs (its marker names it) came from it: no taint.
    const own = `s-spill-own-${process.pid}-${Date.now()}`;
    const ownDir = join(tmpdir(), "atomic-agent-tool-outputs", own);
    mkdirSync(ownDir, { recursive: true });
    made.push(ownDir);
    writeFileSync(join(ownDir, ".atag-source.json"), JSON.stringify({ version: 1, kind: "spill", sessionId: own, policy: stamp }), { mode: 0o600 });
    expect(runWithProviderPolicy(undefined, () =>
      t.taint.noteDispatch("os.fs.read", { path: join(ownDir, "0001-abcdef-x.txt") }, t.ctx(own)))).toBeUndefined();
  });

  it("a copy of an unconstrained folder, and plain scratch files, add nothing", () => {
    const t = setup();
    const copy = fusionRoot();
    writeFileSync(join(copy, ".atag-source.json"), JSON.stringify({ version: 1, kind: "fusion", source: t.open }), { mode: 0o600 });
    expect(runWithProviderPolicy(undefined, () =>
      t.taint.noteDispatch("os.fs.read", { path: join(copy, "base", "a") }, t.ctx("s-open-copy")))).toBeUndefined();
    expect(runWithProviderPolicy(undefined, () =>
      t.taint.noteDispatch("os.fs.read", { path: join(tmpdir(), "helper-out.txt") }, t.ctx("s-scratch")))).toBeUndefined();
  });
});
