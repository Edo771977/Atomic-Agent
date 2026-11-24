import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
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
  resolveSandboxGitExcludes,
  SANDBOX_EXEC,
  wrapWithOsSandbox,
} from "./os-sandbox.js";

const mountFixture = vi.hoisted(() => ({
  contents: undefined as string | undefined,
  blocked: "",
  directoryReads: 0,
  fakeNix: false,
  timeOutFind: false,
  findTimeout: 0,
}));
const useHostSystemInventory = process.env.ATOMIC_AGENT_REQUIRE_BWRAP === "1";
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    statSync: (...args: unknown[]) => mountFixture.fakeNix && (args[0] === "/nix" || args[0] === "/nix/store")
      ? { uid: 0, mode: args[0] === "/nix" ? 0o755 : 0o1775, isDirectory: () => true }
      : Reflect.apply(fs.statSync, fs, args),
    existsSync: (...args: unknown[]) => mountFixture.fakeNix && args[0] === "/nix/store" ||
      Reflect.apply(fs.existsSync, fs, args),
    readdirSync: (...args: unknown[]) => {
      if (args[0] === mountFixture.blocked) mountFixture.directoryReads++;
      return Reflect.apply(fs.readdirSync, fs, args);
    },
    readFileSync: (...args: unknown[]) => args[0] === "/proc/self/mountinfo" && mountFixture.contents !== undefined
      ? mountFixture.contents
      : Reflect.apply(fs.readFileSync, fs, args),
  };
});

vi.mock("node:child_process", async importOriginal => {
  const child = await importOriginal<typeof import("node:child_process")>();
  return {
    ...child,
    spawnSync: (...args: unknown[]) => {
      if (args[0] === "/usr/bin/find" && Array.isArray(args[1]) && args[1].includes("-perm")) {
        const findArgs = args[1] as string[];
        if (mountFixture.timeOutFind) {
          const options = args[2] as { timeout: number; killSignal: string };
          mountFixture.findTimeout = options.timeout;
          expect(options.killSignal).toBe("SIGKILL");
          return { error: Object.assign(new Error("find timed out"), { code: "ETIMEDOUT" }) };
        }
        if (mountFixture.fakeNix && findArgs.includes("/nix/store")) {
          const exemption = findArgs.some((arg, index) => arg === "-path" && findArgs[index + 1] === "/nix/store");
          return { status: 0, stdout: exemption ? "s/nix/store/synthetic.sock\0" : "d/nix/store\0" };
        }
        // Keep real workspace scans in fixture tests. Only the dedicated
        // Bubblewrap workflow needs to traverse the host's system trees.
        if (!useHostSystemInventory) return { status: 0, stdout: "" };
      }
      return Reflect.apply(child.spawnSync, child, args);
    },
  };
});

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

it.skipIf(process.platform !== "linux" || process.env.ATOMIC_AGENT_REQUIRE_BWRAP !== "1")("prepares a typical warmed Linux workspace within the launch budget", () => {
  const root = mkdtempSync(join(tmpdir(), "atomic-launch-budget-"));
  try {
    for (let i = 0; i < 80; i++) {
      const dir = join(root, "src", String(i));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "fixture.txt"), "fixture");
    }
    mkdirSync(join(root, ".git"));
    const timings = Array.from({ length: 6 }, () => {
      const started = performance.now();
      const p = buildOsSandboxPolicy({ workspaceRoots: [root], network: false });
      const built = performance.now();
      const wrapped = wrapWithOsSandbox("/bin/ls", [], p, { cwd: root });
      const prepared = performance.now();
      if (!wrapped.ok) throw new Error(wrapped.reason);
      const child = spawnSync(wrapped.command, wrapped.args, { cwd: root, env: buildOsSandboxEnv(process.env), encoding: "utf8" });
      expect(child.status, child.stderr).toBe(0);
      return [built - started, prepared - built, performance.now() - prepared];
    });
    const warm = timings.slice(1);
    const median = (values: number[]) => values.sort((a, b) => a - b)[2]!;
    const format = (values: number[]) => values.map(value => value.toFixed(1)).join("/");
    console.info(`Safe Mode phase ms (policy/wrap/spawn): first=${format(timings[0]!)} warm-median=${format(
      [0, 1, 2].map(phase => median(warm.map(sample => sample[phase]!))),
    )}`);
    const preparation = warm.map(([policyMs, wrapMs]) => policyMs! + wrapMs!);
    const warmPreparationMs = median(preparation);
    // Shared runners are normally around 100–250 ms and can drift above that.
    // Leave scheduling headroom while catching the historical 10–19 s stalls.
    const launchBudgetMs = 1_000;
    console.info(`Safe Mode warm preparation median: ${warmPreparationMs.toFixed(1)} ms`);
    expect(warmPreparationMs, `warm preparation in ms: ${format(preparation)}`).toBeLessThan(launchBudgetMs);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

  it.skipIf(process.platform !== "linux")("refuses the launch when system inventory times out", () => {
    mountFixture.timeOutFind = true;
    mountFixture.blocked = "/usr/bin";
    mountFixture.directoryReads = 0;
    try {
      const wrapped = wrapWithOsSandbox("true", [], policy(), {
        platform: "linux", bwrap: "/usr/bin/bwrap", disableUsernsAvailable: true,
      });
      expect(wrapped).toEqual({ ok: false, reason: "Linux host inventory exceeded the 30-second preparation limit" });
      expect(mountFixture.findTimeout).toBeGreaterThan(0);
      expect(mountFixture.findTimeout).toBeLessThanOrEqual(30_000);
      expect(mountFixture.directoryReads).toBe(0);
    } finally {
      mountFixture.timeOutFind = false;
      mountFixture.blocked = "";
    }
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
    for (let i = 0; i < 60_001; i++) mkdirSync(join(deps, String(i)));
    const wrapped = wrapWithOsSandbox("true", [], buildOsSandboxPolicy({
      workspaceRoots: [root], network: false,
    }), { platform: "linux", bwrap: "/usr/bin/bwrap" });
    if (!wrapped.ok) throw new Error(wrapped.reason);
    expect(wrapped.args.join(" ")).toContain(`--ro-bind ${deps} ${deps}`);

    renameSync(deps, join(root, "large-tree"));
    const started = performance.now();
    const large = wrapWithOsSandbox("true", [], buildOsSandboxPolicy({
      workspaceRoots: [root], network: false,
    }), { platform: "linux", bwrap: "/usr/bin/bwrap" });
    if (!large.ok) throw new Error(large.reason);
    expect(large.args.join(" ")).not.toContain(`--ro-bind ${root} ${root}`);
    expect(performance.now() - started).toBeLessThan(5000);
    if (process.env.ATOMIC_AGENT_REQUIRE_BWRAP === "1") {
      const writable = wrapWithOsSandbox("/usr/bin/touch", [join(root, "ordinary")], buildOsSandboxPolicy({
        workspaceRoots: [root], network: false,
      }), { cwd: root });
      if (!writable.ok) throw new Error(writable.reason);
      const child = spawnSync(writable.command, writable.args, { cwd: root, env: buildOsSandboxEnv(process.env), encoding: "utf8" });
      expect(child.status, child.stderr).toBe(0);
      expect(existsSync(join(root, "ordinary"))).toBe(true);
    }
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

it.skipIf(process.platform !== "linux")("round 4 point 1: mounts selected system paths without binding the host root", () => {
  const wrapped = wrapWithOsSandbox("true", [], policy(), {
    platform: "linux", bwrap: "/usr/bin/bwrap",
  });
  if (!wrapped.ok) throw new Error(wrapped.reason);
  const args = wrapped.args.join(" ");
  expect(args).not.toContain("--ro-bind / / ");
  expect(args).not.toMatch(/--ro-bind \/(?:etc|usr|usr\/local|var|opt|srv|mnt|media) \//);
  expect(args).toContain("--ro-bind /usr/bin /usr/bin");
  expect(args).not.toContain("--ro-bind /usr/share /usr/share");
  if (existsSync("/usr/share/git-core")) expect(args).toContain("--ro-bind /usr/share/git-core /usr/share/git-core");
});


it.skipIf(process.platform !== "linux")("round 4 point 1: masks an inherited submount inside an authorized workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "atomic-inherited-"));
  const nested = join(root, "inherited");
  mkdirSync(nested);
  mountFixture.contents = `101 100 0:1 /source ${nested} rw - tmpfs fixture rw\n`;
  try {
    const wrapped = wrapWithOsSandbox("true", [], buildOsSandboxPolicy({ workspaceRoots: [root], network: false }), {
      platform: "linux", bwrap: "/usr/bin/bwrap", cwd: root,
    });
    if (!wrapped.ok) throw new Error(wrapped.reason);
    expect(wrapped.args.join(" ")).toContain(`--tmpfs ${nested} --remount-ro ${nested}`);
  } finally {
    mountFixture.contents = undefined;
    rmSync(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== "linux")("round 5 point 1: opts in to UID zero and remounts private proc read-only", () => {
  const uid = vi.spyOn(process, "getuid").mockReturnValue(0);
  try {
    vi.stubEnv("ATOMIC_AGENT_SANDBOX_ALLOW_ROOT", undefined);
    const opts = { bwrap: "/usr/bin/bwrap" };
    expect(wrapWithOsSandbox("true", [], policy(), opts)).toMatchObject({
      ok: false, reason: expect.stringContaining("ATOMIC_AGENT_SANDBOX_ALLOW_ROOT=1"),
    });
    vi.stubEnv("ATOMIC_AGENT_SANDBOX_ALLOW_ROOT", "1");
    const launch = wrapWithOsSandbox("true", [], policy(), opts);
    if (!launch.ok) throw new Error(launch.reason);
    expect(launch.args.join(" ")).toContain("--proc /proc --remount-ro /proc");
  } finally {
    uid.mockRestore();
    vi.unstubAllEnvs();
  }
});

it.skipIf(process.platform !== "linux")("round 5 point 8: global ignores reject relative and workspace-resolved paths", () => {
  const root = mkdtempSync(join(tmpdir(), "atomic-ignores-"));
  try {
    const workspace = join(root, "project");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "rules"), "fixture\n");
    const link = join(root, "rules");
    symlinkSync(join(workspace, "rules"), link);
    const config = join(root, "config");
    vi.stubEnv("GIT_CONFIG_GLOBAL", config);
    const p = buildOsSandboxPolicy({ workspaceRoots: [workspace], network: false });
    for (const value of ["rules", link]) {
      writeFileSync(config, `[core]\nexcludesFile = ${value}\n`);
      expect(resolveSandboxGitExcludes(workspace, p)).toBeUndefined();
    }
  } finally {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});


it.skipIf(process.platform !== "linux" || process.getuid?.() === 0)("round 5 point 9: native socket inventory masks inaccessible directories without the JS walk", () => {
  const root = mkdtempSync(join(tmpdir(), "atomic-denied-inventory-"));
  const blocked = join(root, "blocked");
  mkdirSync(blocked, { mode: 0 });
  mountFixture.blocked = blocked;
  mountFixture.directoryReads = 0;
  try {
    const p = buildOsSandboxPolicy({ workspaceRoots: [root], network: false, gitMetadataWritable: true });
    const launch = wrapWithOsSandbox("true", [], p, { bwrap: "/usr/bin/bwrap" });
    if (!launch.ok) throw new Error(launch.reason);
    expect(launch.args.join(" ")).toContain(`--tmpfs ${blocked} --remount-ro ${blocked}`);
    expect(mountFixture.directoryReads).toBe(0);
  } finally {
    mountFixture.blocked = "";
    chmodSync(blocked, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});


it.skipIf(process.platform !== "linux")("round 5 point 4: a trusted sticky Nix store is visible while sockets are masked", () => {
  mountFixture.fakeNix = true;
  try {
    const launch = wrapWithOsSandbox("true", [], policy(), { bwrap: "/usr/bin/bwrap" });
    if (!launch.ok) throw new Error(launch.reason);
    expect(launch.args.join(" ")).not.toContain("--tmpfs /nix/store");
    expect(launch.args.join(" ")).toContain("--ro-bind /dev/null /nix/store/synthetic.sock");
  } finally {
    mountFixture.fakeNix = false;
  }
});
