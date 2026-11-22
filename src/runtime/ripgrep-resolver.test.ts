import { describe, expect, it, vi } from "vitest";
import { resolveRipgrepPath, type RipgrepResolverOptions } from "./ripgrep-resolver.js";

const defaults: RipgrepResolverOptions = {
  cwd: "/project",
  workingDir: "/session",
  execPath: "/opt/agent/atomic-agent",
  moduleDir: "/opt/agent/dist/runtime",
  env: {},
  platform: "linux",
  sea: false,
  realPath: (path) => path,
};

function inspect(files: string[], options: RipgrepResolverOptions = {}) {
  const fileExists = vi.fn((path: string) => files.includes(path));
  return {
    result: resolveRipgrepPath({ ...defaults, fileExists, ...options }),
    fileExists,
  };
}

describe("resolveRipgrepPath", () => {
  it("prefers the bundle and ignores the legacy environment override", () => {
    const env = { ATOMIC_AGENT_RG_PATH: "/custom/rg", PATH: "/usr/bin" };
    expect(inspect(["/custom/rg", "/opt/agent/vendor/rg", "/usr/bin/rg"], {
      sea: true,
      env,
    }).result).toBe("/opt/agent/vendor/rg");
    expect(inspect(["/custom/rg", "/usr/bin/rg"], {
      env,
    }).result).toBe("/usr/bin/rg");
  });

  it("resolves the vendor executable beside the SEA and avoids module lookup", () => {
    const bundled = "/opt/agent/vendor/rg";
    expect(inspect([bundled], { sea: true }).result).toBe(bundled);
    expect(inspect([bundled]).result).toBeNull();
  });

  it("uses the installed module's dependency and never probes the project's package", () => {
    const installed = "/opt/agent/node_modules/@vscode/ripgrep/bin/rg";
    const project = "/project/node_modules/@vscode/ripgrep/bin/rg";
    const { result, fileExists } = inspect([installed, project]);
    expect(result).toBe(installed);
    expect(fileExists).not.toHaveBeenCalledWith(project);
    expect(inspect([project]).result).toBeNull();
  });

  it("rejects bundled paths inside the project or redirected into it", () => {
    const bundled = "/opt/agent/vendor/rg";
    expect(inspect([bundled], { sea: true, workingDir: "/opt/agent" }).result).toBeNull();
    expect(inspect(["/session/rg"], {
      sea: true,
      realPath: (path) => path === bundled ? "/session/rg" : path,
    }).result).toBeNull();
  });

  it("ignores empty, relative, and project PATH entries and returns the checked absolute executable", () => {
    const system = "/project-sibling/bin/rg";
    const files = ["rg", "bin/rg", "/project/bin/rg", "/session/bin/rg", system];
    const { result, fileExists } = inspect(files, {
      env: { PATH: ":.:bin:/project/bin:/session/bin:/project-sibling/bin" },
    });
    expect(result).toBe(system);
    expect(fileExists).toHaveBeenCalledWith(system);
    expect(fileExists.mock.calls.every(([path]) => path.startsWith("/"))).toBe(true);
  });

  it("checks aliases of the project root and of the candidate executable", () => {
    const aliases: Record<string, string> = {
      "/session": "/real/session",
      "/tools/rg": "/real/session/bin/rg",
      "/bin/rg": "/usr/bin/rg",
    };
    const { result, fileExists } = inspect(["/real/session/bin/rg", "/usr/bin/rg"], {
      env: { PATH: "/tools:/bin" },
      realPath: (path) => aliases[path] ?? path,
    });
    expect(result).toBe("/usr/bin/rg");
    expect(fileExists).not.toHaveBeenCalledWith("/real/session/bin/rg");
    expect(fileExists).toHaveBeenCalledWith("/usr/bin/rg");
  });

  it("handles Windows PATH and accepts only the explicit exe suffix", () => {
    const root = String.raw`C:\Project`;
    const session = String.raw`C:\Session`;
    const system = String.raw`C:\Tools\rg.exe`;
    const { result, fileExists } = inspect([
      String.raw`c:\PROJECT\bin\rg.exe`,
      String.raw`C:\SESSION\rg.exe`,
      String.raw`C:\Wrappers\rg.cmd`,
      system,
    ], {
      platform: "win32",
      sea: true,
      execPath: String.raw`C:\Agent\atomic-agent.exe`,
      cwd: root,
      workingDir: session,
      env: { Path: String.raw`;.;C:bin;\bin;c:\PROJECT\bin;C:\SESSION;C:\Wrappers;C:\Tools`, PATHEXT: ".CMD;.EXE" },
    });
    expect(result).toBe(system);
    expect(fileExists).toHaveBeenCalledWith(String.raw`C:\Agent\vendor\rg.exe`);
    expect(fileExists.mock.calls.every(([path]) => path.endsWith(".exe"))).toBe(true);
  });

  it("returns null when an executable is unavailable", () => {
    expect(inspect([]).result).toBeNull();
  });
});
