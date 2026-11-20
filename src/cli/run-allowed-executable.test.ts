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
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "aa-resolve-")));
  const runDir = join(base, "proj");
  const planted = join(runDir, "bin");
  const system = join(base, "system-bin");
  mkdirSync(planted, { recursive: true });
  mkdirSync(system, { recursive: true });
  exe(planted, "tool");
  const real = exe(system, "tool");

  it("skips a PATH entry inside --cwd, a relative one and an empty one, and takes the first real file outside", () => {
    const PATH = [planted, "bin", "", ".", system].join(delimiter);
    expect(resolveAllowedExecutable("tool", { runDir, env: { PATH }, platform: "linux" })).toMatchObject({ file: real, path: system });
  });

  it("refuses when only --cwd holds it, or when the file it resolves to is a link into --cwd", () => {
    expect(resolveAllowedExecutable("tool", { runDir, env: { PATH: planted }, platform: "linux" })).toHaveProperty("refused");
    const linkDir = join(base, "links");
    mkdirSync(linkDir, { recursive: true });
    symlinkSync(join(planted, "tool"), join(linkDir, "tool"));
    expect(resolveAllowedExecutable("tool", { runDir, env: { PATH: linkDir }, platform: "linux" })).toHaveProperty("refused");
  });

  it("refuses a word with a path inside --cwd, takes an absolute one outside", () => {
    expect(resolveAllowedExecutable(join(planted, "tool"), { runDir, env: { PATH: "" }, platform: "linux" })).toHaveProperty("refused");
    expect(resolveAllowedExecutable("./bin/tool", { runDir, env: { PATH: "" }, platform: "linux" })).toHaveProperty("refused");
    expect(resolveAllowedExecutable(real, { runDir, env: { PATH: "" }, platform: "linux" })).toMatchObject({ file: real });
  });

  it("refuses a script whose #! names an interpreter inside --cwd or by a relative path; gives the filtered PATH", () => {
    const scripts = join(base, "scripts");
    mkdirSync(scripts, { recursive: true });
    const write = (name: string, shebang: string) => {
      writeFileSync(join(scripts, name), `${shebang}\necho x\n`);
      chmodSync(join(scripts, name), 0o755);
    };
    write("inside", `#!${join(runDir, "bin", "tool")}`);
    write("relative", "#!bin/tool");
    write("viaenv", "#!/usr/bin/env node");
    const env = { PATH: ["", ".", planted, scripts, system].join(delimiter) };
    expect(resolveAllowedExecutable("inside", { runDir, env, platform: "linux" })).toHaveProperty("refused");
    expect(resolveAllowedExecutable("relative", { runDir, env, platform: "linux" })).toHaveProperty("refused");
    expect(resolveAllowedExecutable("viaenv", { runDir, env, platform: "linux" })).toEqual({
      file: join(scripts, "viaenv"),
      path: [scripts, system].join(delimiter),
    });
  });

  it("refuses a file that is not executable, and a name nothing resolves", () => {
    const plain = join(system, "plain");
    writeFileSync(plain, "x");
    chmodSync(plain, 0o644);
    expect(resolveAllowedExecutable("plain", { runDir, env: { PATH: system }, platform: "linux" })).toHaveProperty("refused");
    expect(resolveAllowedExecutable("nowhere", { runDir, env: { PATH: system }, platform: "linux" })).toHaveProperty("refused");
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
    expect(resolveAllowedExecutable("node", opts("C:\\node"))).toMatchObject({ file: "C:\\node\\node.exe" });
    files.add("c:\\node\\node.com");
    expect(resolveAllowedExecutable("node", opts("C:\\node"))).toMatchObject({ file: "C:\\node\\node.com" });
  });

  it("refuses when the first match is a .cmd or .bat, or the word names one", () => {
    files.clear();
    files.add("c:\\tools\\npm.cmd");
    files.add("c:\\node\\npm.exe");
    expect(resolveAllowedExecutable("npm", opts(["C:\\tools", "C:\\node"].join(win32.delimiter)))).toHaveProperty("refused");
    expect(resolveAllowedExecutable("npm.cmd", opts("C:\\tools"))).toHaveProperty("refused");
    expect(resolveAllowedExecutable("run.bat", opts("C:\\tools"))).toHaveProperty("refused");
  });

  it("never uses --cwd, a relative entry or an empty one", () => {
    files.clear();
    files.add("c:\\work\\proj\\node.exe");
    files.add("c:\\node\\node.exe");
    expect(resolveAllowedExecutable("node", opts(["C:\\work\\proj", "bin", "", "C:\\node"].join(win32.delimiter)))).toMatchObject({ file: "C:\\node\\node.exe" });
    expect(resolveAllowedExecutable("node", opts("C:\\work\\proj"))).toHaveProperty("refused");
  });
});
