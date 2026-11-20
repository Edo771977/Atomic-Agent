import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, win32 } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveAllowedExecutable, type ExecutableFs } from "./run-allowed-executable.js";

/**
 * Issue #95 (second review): `--allow-command node …` must pin the real
 * `node`, never one the model can plant in --cwd or reach through a
 * relative or empty PATH entry.
 */
describe("resolveAllowedExecutable on POSIX", () => {
  const exe = (dir: string, name: string): string => {
    const file = join(dir, name);
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
    return file;
  };
  const base = realpathSync(mkdtempSync(join(tmpdir(), "aa-resolve-")));
  const runDir = join(base, "proj");
  const planted = join(runDir, "bin");
  const system = join(base, "system-bin");
  mkdirSync(planted, { recursive: true });
  mkdirSync(system, { recursive: true });
  exe(planted, "tool");
  const real = exe(system, "tool");

  it("skips a PATH entry inside --cwd, a relative one and an empty one, and takes the first real file outside", () => {
    const PATH = [planted, "bin", "", ".", system].join(delimiter);
    expect(resolveAllowedExecutable("tool", { runDir, env: { PATH }, platform: "linux" })).toEqual({ file: real });
  });

  it("refuses when only --cwd holds it, or when the file it resolves to is a link into --cwd", () => {
    expect(resolveAllowedExecutable("tool", { runDir, env: { PATH: planted }, platform: "linux" })).toBeNull();
    const linkDir = join(base, "links");
    mkdirSync(linkDir, { recursive: true });
    symlinkSync(join(planted, "tool"), join(linkDir, "tool"));
    expect(resolveAllowedExecutable("tool", { runDir, env: { PATH: linkDir }, platform: "linux" })).toBeNull();
  });

  it("refuses a word with a path inside --cwd, takes an absolute one outside", () => {
    expect(resolveAllowedExecutable(join(planted, "tool"), { runDir, env: { PATH: "" }, platform: "linux" })).toBeNull();
    expect(resolveAllowedExecutable("./bin/tool", { runDir, env: { PATH: "" }, platform: "linux" })).toBeNull();
    expect(resolveAllowedExecutable(real, { runDir, env: { PATH: "" }, platform: "linux" })).toEqual({ file: real });
  });

  it("refuses a file that is not executable, and a name nothing resolves", () => {
    const plain = join(system, "plain");
    writeFileSync(plain, "x");
    chmodSync(plain, 0o644);
    expect(resolveAllowedExecutable("plain", { runDir, env: { PATH: system }, platform: "linux" })).toBeNull();
    expect(resolveAllowedExecutable("nowhere", { runDir, env: { PATH: system }, platform: "linux" })).toBeNull();
  });
});

describe("resolveAllowedExecutable with Windows semantics (injected fs)", () => {
  const files = new Set<string>();
  const fs: ExecutableFs = {
    isExecutableFile: (path) => files.has(path.toLowerCase()),
    realpath: (path) => (files.has(path.toLowerCase()) || /^c:\\(tools|node|work|work\\proj)$/i.test(path) ? path : null),
  };
  const opts = (PATH: string, PATHEXT = ".COM;.EXE;.BAT;.CMD") =>
    ({ runDir: "C:\\work\\proj", env: { PATH, PATHEXT }, platform: "win32" as const, fs });

  it("tries .exe and .com only, in PATHEXT order", () => {
    files.clear();
    files.add("c:\\node\\node.exe");
    expect(resolveAllowedExecutable("node", opts("C:\\node"))).toEqual({ file: "C:\\node\\node.exe" });
    files.add("c:\\node\\node.com");
    expect(resolveAllowedExecutable("node", opts("C:\\node"))).toEqual({ file: "C:\\node\\node.com" });
  });

  it("refuses when the first match is a .cmd or .bat, or the word names one", () => {
    files.clear();
    files.add("c:\\tools\\npm.cmd");
    files.add("c:\\node\\npm.exe");
    expect(resolveAllowedExecutable("npm", opts(["C:\\tools", "C:\\node"].join(win32.delimiter)))).toBeNull();
    expect(resolveAllowedExecutable("npm.cmd", opts("C:\\tools"))).toBeNull();
    expect(resolveAllowedExecutable("run.bat", opts("C:\\tools"))).toBeNull();
  });

  it("never uses --cwd, a relative entry or an empty one", () => {
    files.clear();
    files.add("c:\\work\\proj\\node.exe");
    files.add("c:\\node\\node.exe");
    expect(resolveAllowedExecutable("node", opts(["C:\\work\\proj", "bin", "", "C:\\node"].join(win32.delimiter)))).toEqual({ file: "C:\\node\\node.exe" });
    expect(resolveAllowedExecutable("node", opts("C:\\work\\proj"))).toBeNull();
  });
});
