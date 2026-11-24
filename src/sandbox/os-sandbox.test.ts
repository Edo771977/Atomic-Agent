import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  buildOsSandboxPolicy,
  buildOsSandboxEnv,
  findBwrap,
  buildSeatbeltProfile,
  formatSandboxUnavailable,
  readOsSandboxSettings,
  SANDBOX_EXEC,
  wrapWithOsSandbox,
} from "./os-sandbox.js";

const HOME = "/home/op";
const TMP = "/var/tmp-op";

function policy(network = false, stateDir = "/home/op/.atomic-agent") {
  return buildOsSandboxPolicy({
    workspaceRoots: ["/home/op/project"],
    stateDir,
    network,
    home: HOME,
    tmp: TMP,
  });
}

describe("readOsSandboxSettings (ATO-469)", () => {
  it("is off unless asked for, and a typo stays off", () => {
    expect(readOsSandboxSettings({})).toEqual({ mode: "off", network: false });
    expect(readOsSandboxSettings({ ATOMIC_AGENT_SANDBOX: "workspce" }).mode).toBe("off");
  });

  it("turns on with workspace, network off unless allowed", () => {
    expect(readOsSandboxSettings({ ATOMIC_AGENT_SANDBOX: "workspace" })).toEqual({
      mode: "workspace",
      network: false,
    });
    expect(
      readOsSandboxSettings({
        ATOMIC_AGENT_SANDBOX: "Workspace",
        ATOMIC_AGENT_SANDBOX_NETWORK: "on",
      }),
    ).toEqual({ mode: "workspace", network: true });
  });
});

it("prepares the wrapper without caller-controlled native loader settings", () => {
  const env = buildOsSandboxEnv({
    PATH: "/usr/bin",
    LD_PRELOAD: "/fixture/loader.so",
    LD_DEBUG_OUTPUT: "/fixture/loader.log",
    DYLD_INSERT_LIBRARIES: "/fixture/loader.dylib",
    GCONV_PATH: "/fixture",
    SSH_AUTH_SOCK: "/fixture/ssh-agent.sock",
    DOCKER_HOST: "unix:///fixture/docker.sock",
    XDG_CACHE_HOME: "/fixture/cache",
  });
  expect(env).toEqual({
    PATH: "/usr/bin",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    TMPDIR: process.platform === "linux" ? "/tmp" : tmpdir(),
    XDG_CACHE_HOME: expect.stringContaining("atomic-agent-tool-cache-"),
    npm_config_cache: join(env.XDG_CACHE_HOME!, "npm"),
  });
});

it("ignores a Bubblewrap executable supplied by the command PATH", () => {
  const dir = mkdtempSync(join(tmpdir(), "atomic-sbx-path-"));
  const fake = join(dir, "bwrap");
  try {
    writeFileSync(fake, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    vi.stubEnv("PATH", dir);
    expect(findBwrap()).not.toBe(fake);
  } finally {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("buildOsSandboxPolicy", () => {
  it("writes go to the project and temp only", () => {
    const p = policy();
    expect(p.writableRoots[0]).toBe("/home/op/project");
    if (process.platform !== "linux") expect(p.writableRoots).toContain(TMP);
    expect(p.writableRoots).not.toContain("/home/op/.npm/_cacache");
    expect(p.writableRoots).not.toContain(HOME);
  });

  it("hides credential folders and the agent's state", () => {
    const p = policy();
    expect(p.denyRead).toContain("/home/op/.ssh");
    expect(p.denyRead).toContain("/home/op/.aws");
    expect(p.denyRead).toContain("/home/op/.atomic-agent");
  });

  it("protects a configured model key outside the state root", () => {
    const p = buildOsSandboxPolicy({
      workspaceRoots: ["/home/op/project"],
      stateDir: "/home/op/state",
      protectedPaths: ["/srv/models/llama-server.key", "/home/op/state/serve-api.key"],
      network: false,
      home: HOME,
      tmp: TMP,
    });
    expect(p.denyRead).toContain("/srv/models/llama-server.key");
    expect(p.denyRead).not.toContain("/home/op/state/serve-api.key");
  });

  it("keeps the state directory hidden when it contains the working folder", () => {
    const p = buildOsSandboxPolicy({
      workspaceRoots: ["/home/op/.atomic-agent/workspace"],
      stateDir: "/home/op/.atomic-agent",
      network: false,
      home: HOME,
      tmp: TMP,
    });
    expect(p.denyRead).toContain("/home/op/.atomic-agent");
    expect(buildSeatbeltProfile(p)).not.toContain("(param \"O0\")");
  });

  it.skipIf(process.platform === "win32")("lists a linked credential folder under its real path too", () => {
    const home = mkdtempSync(join(tmpdir(), "atomic-sbx-home-"));
    try {
      mkdirSync(join(home, "dotfiles/ssh"), { recursive: true });
      symlinkSync(join(home, "dotfiles/ssh"), join(home, ".ssh"));
      const p = buildOsSandboxPolicy({ workspaceRoots: [join(home, "w")], network: false, home, tmp: TMP });
      expect(p.denyRead).toContain(join(home, ".ssh"));
      expect(p.denyRead).toContain(realpathSync(join(home, "dotfiles/ssh")));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("buildSeatbeltProfile", () => {
  it("never puts a path into the profile text", () => {
    const p = buildOsSandboxPolicy({
      workspaceRoots: ['/home/op/evil") (allow file-write* (subpath "/'],
      network: false,
      home: HOME,
      tmp: TMP,
    });
    const profile = buildSeatbeltProfile(p);
    expect(profile).not.toContain("evil");
    expect(profile).toContain('(subpath (param "W0"))');
  });

  it("denies all writes before allowing the roots, and blocks the network", () => {
    const profile = buildSeatbeltProfile(policy(false));
    const lines = profile.split("\n");
    expect(lines.indexOf("(deny file-write*)")).toBeLessThan(
      lines.findIndex((l) => l.startsWith("(allow file-write*")),
    );
    expect(profile).toContain("(deny file-read* file-write* (subpath (param \"R0\"))");
    expect(profile).toContain('(deny network-outbound (remote ip "*:*") (remote unix-socket))');
    expect(profile).toContain('(allow network-outbound (remote ip "localhost:*"))');
    expect(profile).toContain('(global-name "com.apple.mDNSResponder")');
    expect(profile).toContain('(global-name "com.apple.coreservices.launchservicesd")');
  });

  it("permits IP with approval and continues to block desktop IPC", () => {
    const profile = buildSeatbeltProfile(policy(true));
    expect(profile).not.toContain('(remote ip "*:*")');
    expect(profile).toContain("mach-lookup");
  });
});

describe("wrapWithOsSandbox", () => {
  it("wraps with sandbox-exec on macOS, paths as -D parameters", () => {
    const w = wrapWithOsSandbox("/bin/sh", ["-c", "ls"], policy(), {
      platform: "darwin",
      seatbeltAvailable: true,
    });
    expect(w.ok).toBe(true);
    if (!w.ok) return;
    expect(w.command).toBe(SANDBOX_EXEC);
    expect(w.args).toContain("W0=/home/op/project");
    expect(w.args.slice(-3)).toEqual(["/bin/sh", "-c", "ls"]);
  });

  it("wraps with bwrap on Linux and drops the network", () => {
    const w = wrapWithOsSandbox("/bin/sh", ["-c", "ls"], policy(), {
      platform: "linux",
      bwrap: "/usr/bin/bwrap",
    });
    expect(w.ok).toBe(true);
    if (!w.ok) return;
    expect(w.command).toBe("/usr/bin/bwrap");
    expect(w.args.slice(0, 2)).toEqual(["--dev", "/dev"]);
    expect(w.args).toContain("--unshare-net");
    expect(w.args).toContain("--unshare-pid");
    expect(w.args).toContain("--proc");
    expect(w.args.slice(-4)).toEqual(["--", "/bin/sh", "-c", "ls"]);
  });

  it("covers a secret file with /dev/null and a folder with tmpfs on Linux", () => {
    const home = mkdtempSync(join(tmpdir(), "atomic-sbx-home-"));
    try {
      writeFileSync(join(home, ".netrc"), "machine x login y password z\n");
      mkdirSync(join(home, ".ssh"));
      const p = buildOsSandboxPolicy({ workspaceRoots: [join(home, "w")], network: false, home, tmp: TMP });
      const w = wrapWithOsSandbox("ls", [], p, { platform: "linux", bwrap: "/usr/bin/bwrap" });
      if (!w.ok) throw new Error(w.reason);
      const at = (path: string) => w.args.indexOf(path);
      expect(w.args[at(join(home, ".netrc")) - 1]).toBe("/dev/null");
      expect(w.args[at(join(home, ".netrc")) - 2]).toBe("--ro-bind");
      expect(w.args[at(join(home, ".ssh")) - 1]).toBe("--tmpfs");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("says why when there is no sandbox, and how to turn it off", () => {
    const linux = wrapWithOsSandbox("ls", [], policy(), { platform: "linux", bwrap: null });
    expect(linux.ok).toBe(false);
    const win = wrapWithOsSandbox("ls", [], policy(), { platform: "win32" });
    expect(win.ok).toBe(false);
    if (win.ok) return;
    expect(formatSandboxUnavailable(win.reason)).toContain("ATOMIC_AGENT_SANDBOX");
  });
});

it("review 4: drop all Linux capabilities", () => {
  const w = wrapWithOsSandbox("true", [], policy(), { platform: "linux", bwrap: "/usr/bin/bwrap" });
  expect(w.ok && w.args).toEqual(expect.arrayContaining(["--cap-drop", "ALL", "--unshare-user"]));
});

it("review 7: restrict macOS IPC even with network approval", () => {
  const profile = buildSeatbeltProfile(policy(true));
  expect(profile).toContain("(deny appleevent-send)");
  expect(profile).toContain("com.apple.securityd");
  expect(profile).toContain("(deny network-outbound (remote unix-socket))");
});

it("review 12: isolate Linux IPC", () => {
  const w = wrapWithOsSandbox("true", [], policy(), { platform: "linux", bwrap: "/usr/bin/bwrap" });
  expect(w.ok && w.args).toContain("--unshare-ipc");
});

it("review 1: Linux uses a private temporary mount and strips desktop IPC variables", () => {
  const wrapper = wrapWithOsSandbox("true", [], policy(), { platform: "linux", bwrap: "/usr/bin/bwrap" });
  expect(wrapper.ok && wrapper.args.join(" ")).toContain("--tmpfs /tmp");
  expect(buildOsSandboxEnv({ DISPLAY: ":9", DBUS_SESSION_BUS_ADDRESS: "fixture", TMUX: "fixture" })).not.toHaveProperty("DISPLAY");
});

it("review 5: rejects protected state beneath a writable root", () => {
  const p = policy(false, "/home/op/project/parent/state");
  const result = wrapWithOsSandbox("true", [], p, { platform: "linux", bwrap: "/usr/bin/bwrap" });
  expect(result).toMatchObject({ ok: false });
});

it("review 6: masks a synthetic home", () => {
  const wrapper = wrapWithOsSandbox("true", [], policy(), { platform: "linux", bwrap: "/usr/bin/bwrap" });
  expect(wrapper.ok && wrapper.args.join(" ")).toContain("--tmpfs " + HOME);
});

it("review 11: commands receive distinct tool cache paths", () => {
  expect(buildOsSandboxEnv({}).XDG_CACHE_HOME).not.toBe(buildOsSandboxEnv({}).XDG_CACHE_HOME);
});

it("round 3 point 1: privatizes Linux runtime directories", () => {
  const wrapped = wrapWithOsSandbox("true", [], policy(true), { platform: "linux", bwrap: "/usr/bin/bwrap" });
  expect(wrapped.ok && wrapped.args.join(" ")).toContain("--tmpfs /run --tmpfs /run/lock");
  expect(wrapped.ok && wrapped.args.join(" ")).toContain("--tmpfs /var/tmp");
});

it("round 3 point 3: rejects a missing protected model file below a writable root", () => {
  const scoped = buildOsSandboxPolicy({
    workspaceRoots: ["/fixture/project"], stateDir: "/fixture/state",
    protectedPaths: ["/fixture/project/models/missing.key"], network: false,
  });
  expect(wrapWithOsSandbox("true", [], scoped, { platform: "linux", bwrap: "/usr/bin/bwrap" }).ok).toBe(false);
});

it("round 3 point 4: refuses a workspace inside state and passes an explicit chdir", () => {
  expect(wrapWithOsSandbox("true", [], policy(false, "/home/op"), { platform: "linux", bwrap: "/usr/bin/bwrap" }).ok).toBe(false);
  const wrapped = wrapWithOsSandbox("true", [], policy(), {
    platform: "linux", bwrap: "/usr/bin/bwrap", cwd: "/home/op/project",
  });
  expect(wrapped.ok && wrapped.args.join(" ")).toContain("--chdir /home/op/project");
});

it("round 3 point 5: protects root home and privileged etc files", () => {
  expect(policy().denyRead).toEqual(expect.arrayContaining(["/root", "/etc/shadow", "/etc/gshadow", "/etc/sudoers", "/etc/sudoers.d"]));
});

it("round 3 point 6: disables nested user namespaces when Bubblewrap supports it", () => {
  const wrapped = wrapWithOsSandbox("true", [], policy(), {
    platform: "linux", bwrap: "/usr/bin/bwrap", disableUsernsAvailable: true,
  });
  expect(wrapped.ok && wrapped.args).toContain("--disable-userns");
});

it("round 3 point 7: reopens Node installed under the private tmp mount", () => {
  const scoped = buildOsSandboxPolicy({
    workspaceRoots: [], home: HOME, nodeExecutable: "/tmp/fixture-node/bin/node",
    toolchainDirectories: ["/fixture/toolchain"], network: false,
  });
  expect(scoped.toolchainRoots).toEqual(expect.arrayContaining(["/tmp/fixture-node/bin", "/fixture/toolchain"]));
});

it("round 3 point 8: drops the host Git config override while preserving explicit identity", () => {
  expect(buildOsSandboxEnv({
    GIT_CONFIG_GLOBAL: "/fixture/git.ini",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  })).toMatchObject({
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  });
});

it("round 4 point 7: refuses a cwd outside the workspace", () => {
  expect(wrapWithOsSandbox("true", [], policy(), {
    platform: "linux", bwrap: "/usr/bin/bwrap", cwd: "/home/op/other",
  })).toEqual({ ok: false, reason: expect.stringContaining("outside the authorized workspace") });
});

it("round 4 point 4: mounts a workspace toolchain read-only after the writable workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "atomic-toolchain-"));
  try {
    const toolchain = join(root, "toolchain");
    mkdirSync(toolchain);
    const wrapped = wrapWithOsSandbox("true", [], buildOsSandboxPolicy({
      workspaceRoots: [root], network: false, toolchainDirectories: [toolchain],
    }), { platform: "linux", bwrap: "/usr/bin/bwrap" });
    if (!wrapped.ok) throw new Error(wrapped.reason);
    expect(wrapped.args.lastIndexOf(toolchain)).toBeGreaterThan(wrapped.args.lastIndexOf(root));
    if (process.env.ATOMIC_AGENT_REQUIRE_BWRAP === "1") {
      const real = wrapWithOsSandbox(process.execPath, ["-e",
        "try{require('node:fs').writeFileSync(process.argv[1],'fixture');process.exit(2)}catch(e){process.exit(e.code==='EROFS'?0:3)}",
        join(toolchain, "marker"),
      ], buildOsSandboxPolicy({ workspaceRoots: [root], network: false, toolchainDirectories: [toolchain] }), { cwd: root });
      if (!real.ok) throw new Error(real.reason);
      const child = spawnSync(real.command, real.args, { cwd: root, env: buildOsSandboxEnv(process.env), encoding: "utf8" });
      expect(child.status, child.stderr).toBe(0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== "linux")("round 4 point 2: hides backup and private host credential paths", () => {
  expect(policy().denyRead).toEqual(expect.arrayContaining([
    "/etc/shadow-", "/etc/gshadow-", "/etc/ssh", "/etc/ssl/private", "/var/backups",
  ]));
  for (const path of (process.env.ATOMIC_AGENT_TEST_PRIVATE_FILES ?? "").split(":").filter(Boolean)) {
    const launch = wrapWithOsSandbox("/bin/cat", [path], policy(), { bwrap: "/usr/bin/bwrap" });
    if (!launch.ok) throw new Error(launch.reason);
    const child = spawnSync(launch.command, launch.args, { cwd: "/", env: buildOsSandboxEnv(process.env), encoding: "utf8" });
    expect(child.error).toBeUndefined();
    expect(child.stderr).not.toContain("bwrap:");
    expect(child.stdout, path).toBe("");
  }
});

it("round 4 point 5: a large dependency tree stays read-only without blocking shell launch", () => {
  const root = mkdtempSync(join(tmpdir(), "atomic-large-workspace-"));
  try {
    const deps = join(root, "node_modules");
    mkdirSync(deps);
    for (let i = 0; i < 50_001; i++) mkdirSync(join(deps, String(i)));
    const wrapped = wrapWithOsSandbox("true", [], buildOsSandboxPolicy({
      workspaceRoots: [root], network: false,
    }), { platform: "linux", bwrap: "/usr/bin/bwrap" });
    if (!wrapped.ok) throw new Error(wrapped.reason);
    expect(wrapped.args.join(" ")).toContain(`--ro-bind ${deps} ${deps}`);

    renameSync(deps, join(root, "large-tree"));
    const large = wrapWithOsSandbox("true", [], buildOsSandboxPolicy({
      workspaceRoots: [root], network: false,
    }), { platform: "linux", bwrap: "/usr/bin/bwrap" });
    if (!large.ok) throw new Error(large.reason);
    expect(large.args.join(" ")).toContain(`--ro-bind ${root} ${root}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

it.skipIf(process.platform !== "linux" || process.getuid?.() === 0)("round 4 point 5: inaccessible directories do not abort policy preparation", () => {
  const root = mkdtempSync(join(tmpdir(), "atomic-inaccessible-"));
  const unreadable = join(root, "unreadable");
  mkdirSync(unreadable);
  chmodSync(unreadable, 0);
  try {
    const p = buildOsSandboxPolicy({ workspaceRoots: [root], network: false });
    expect(wrapWithOsSandbox("true", [], p, { cwd: dirname(root) })).toMatchObject({ ok: false });
    const wrapped = wrapWithOsSandbox("true", [], p, { platform: "linux", bwrap: "/usr/bin/bwrap" });
    if (!wrapped.ok) throw new Error(wrapped.reason);
    expect(wrapped.args.join(" ")).toContain(`--ro-bind ${unreadable} ${unreadable}`);
  } finally {
    chmodSync(unreadable, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

it("round 4 point 1: mounts selected system paths without binding the host root", () => {
  const wrapped = wrapWithOsSandbox("true", [], policy(), {
    platform: "linux", bwrap: "/usr/bin/bwrap",
  });
  if (!wrapped.ok) throw new Error(wrapped.reason);
  const args = wrapped.args.join(" ");
  expect(args).not.toContain("--ro-bind / / ");
  expect(args).not.toMatch(/--ro-bind \/(?:etc|usr|usr\/local|var|opt|srv|mnt|media) \//);
  expect(args).toContain("--ro-bind /usr/bin /usr/bin");
});
