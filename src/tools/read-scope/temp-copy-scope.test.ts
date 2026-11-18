import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { makeProviderPolicy } from "../../config/project-constraint-match.js";
import { createWriteOutGuard } from "../tool-write-out.js";
import { findSessionReadOutside, sessionReadRoots } from "./read-scope.js";

/**
 * Issue #74 item 2: the temp folders that hold another session's or a
 * copy's content (fusion branch workspaces, verify copies, spill folders)
 * are not plain scratch: another session's folder needs the normal
 * read-scope prompt, and the write-out guard reads a copy's policy from
 * its marker.
 */
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const marker = (dir: string, body: Record<string, unknown>): void =>
  writeFileSync(join(dir, ".atag-source.json"), JSON.stringify({ version: 1, ...body }), { mode: 0o600 });

function fusionRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "atag-fusion-0a0b0c-"));
  made.push(dir);
  mkdirSync(join(dir, "base"), { recursive: true });
  return dir;
}

function spillDir(sessionId: string): string {
  const dir = join(tmpdir(), "atomic-agent-tool-outputs", sessionId);
  mkdirSync(dir, { recursive: true });
  made.push(dir);
  return dir;
}

describe("read scope of temp copies", () => {
  const work = "/srv/homes/me/project";
  const ctx = (sessionId: string) => ({ sessionId, workingDir: work });
  const outside = (path: string, sessionId = "s-me") =>
    findSessionReadOutside("os.fs.read", { path }, ctx(sessionId), sessionReadRoots(ctx(sessionId)));

  it("another session's spill folder is outside scope; one's own is not", () => {
    const tag = `${process.pid}-${Date.now()}`;
    const other = spillDir(`s-other-${tag}`);
    marker(other, { kind: "spill", sessionId: `s-other-${tag}` });
    const file = join(other, "0001-abcdef-os-shell-run.txt");
    expect(outside(file, `s-me-${tag}`)).toBe(file);
    expect(outside(file, `s-other-${tag}`)).toBeNull();
  });

  it("a fusion copy is in scope only for the session that made it", () => {
    const copy = fusionRoot();
    marker(copy, { kind: "fusion", source: work, sessionId: "s-owner" });
    const file = join(copy, "base", "notes.txt");
    expect(outside(file, "s-owner")).toBeNull();
    expect(outside(file, "s-stranger")).toBe(file);
    const unmarked = fusionRoot();
    expect(outside(join(unmarked, "base", "x"), "s-owner")).toBe(join(unmarked, "base", "x"));
  });

  it("other temp files stay scratch", () => {
    expect(outside(join(tmpdir(), "helper.py"))).toBeNull();
    expect(outside(join(tmpdir(), "atag-fusion-not-a-run", "x"))).toBeNull();
  });
});

describe("write-out guard and temp copies", () => {
  const secretDir = "/work/secret";
  const config = { projects: { constraints: { [secretDir]: { allowedProviders: ["local-llama"] } } } };
  const secret = makeProviderPolicy({ key: secretDir, allowedProviders: ["local-llama"], matchedDir: secretDir });
  const guard = (policy = secret as typeof secret | undefined) => createWriteOutGuard({
    policyForSession: () => policy,
    readConfig: () => config,
    ownScratchDir: () => undefined,
    platform: "linux",
    realpath: () => undefined,
  });

  it("a copy of the same constrained folder holds its content; a copy of an open folder does not", () => {
    const same = fusionRoot();
    marker(same, { kind: "fusion", source: secretDir });
    expect(guard()("os.fs.write", { path: join(same, "base", "out.md") }, { sessionId: "s", workingDir: secretDir })).toBeNull();
    const open = fusionRoot();
    marker(open, { kind: "fusion", source: "/work/open" });
    expect(guard()("os.fs.write", { path: join(open, "base", "out.md") }, { sessionId: "s", workingDir: secretDir })).not.toBeNull();
  });

  it("no session may overwrite a temp root's marker with a file tool", () => {
    const copy = fusionRoot();
    marker(copy, { kind: "fusion", source: secretDir });
    for (const policy of [secret, undefined]) {
      const refused = guard(policy)("os.fs.write", { path: join(copy, ".atag-source.json") }, { sessionId: "s", workingDir: "/work/open" });
      expect(refused?.message, String(policy?.key)).toMatch(/marker/);
    }
  });
});
