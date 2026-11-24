/**
 * Wrap a child process with the platform's filesystem and network policy.
 * Bubblewrap isolates Linux process IDs and mounts a private procfs.
 * Seatbelt on macOS keeps host loopback and uses parameterized paths.
 * Callers must refuse to spawn when a requested wrapper is unavailable.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type OsSandboxMode = "off" | "workspace";

export interface OsSandboxSettings {
  mode: OsSandboxMode;
  /** Whether the operator permits one-time command network requests. */
  network: boolean;
}

export const SANDBOX_MODE_ENV = "ATOMIC_AGENT_SANDBOX";
export const SANDBOX_NETWORK_ENV = "ATOMIC_AGENT_SANDBOX_NETWORK";

/**
 * Read the switch from the agent's environment. Anything but
 * `workspace` (or its aliases) is off, so a typo never half-enables it.
 */
export function readOsSandboxSettings(
  env: NodeJS.ProcessEnv = process.env,
): OsSandboxSettings {
  const raw = (env[SANDBOX_MODE_ENV] ?? "").trim().toLowerCase();
  const mode: OsSandboxMode =
    raw === "workspace" || raw === "on" || raw === "1" || raw === "true"
      ? "workspace"
      : "off";
  const net = (env[SANDBOX_NETWORK_ENV] ?? "").trim().toLowerCase();
  return { mode, network: net === "on" || net === "1" || net === "true" };
}

/** Prepare the wrapper environment before the kernel has installed confinement. */
export function buildOsSandboxEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const safe = Object.fromEntries(Object.entries(env).filter(([key]) =>
    !/^(?:LD_|DYLD_|_RLD_)|^(?:GLIBC_TUNABLES|GCONV_PATH|LOCPATH|NLSPATH|GIO_EXTRA_MODULES|GIO_MODULE_DIR|SSH_AUTH_SOCK|DOCKER_HOST|DBUS_SESSION_BUS_ADDRESS|DISPLAY|XAUTHORITY|WAYLAND_DISPLAY|TMUX|XDG_RUNTIME_DIR)$/.test(key)));
  const temp = process.platform === "linux" ? "/tmp" : tmpdir();
  const cache = join(temp, `atomic-agent-tool-cache-${randomUUID()}`);
  return { ...safe, GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0", TMPDIR: temp, XDG_CACHE_HOME: cache, npm_config_cache: join(cache, "npm") };
}

export interface OsSandboxPolicy {
  /** Folders the command may write under (working folders first). */
  writableRoots: readonly string[];
  workspaceRoots: readonly string[];
  readOnlyGitRoots: readonly string[];
  gitMetadataWritable: boolean;
  readOnlyWorkspaceRoots: readonly string[];
  /**
   * Folders and files the command may not read (credential stores,
   * agent state). Each one is listed both as named and, when it is a
   * link, as the resolved target: Seatbelt matches resolved paths.
   */
  denyRead: readonly string[];
  network: boolean;
  stateDir: string;
  protectedParents: readonly string[];
  home: string;
  maskedHomes: readonly string[];
  toolchainRoots: readonly string[];
}

export interface OsSandboxPolicyInput {
  /**
   * The trusted working folders: the session's working directory and
   * any other workspace roots. Never a model-supplied `cwd`: that
   * argument is what the sandbox distrusts, so it must not widen it.
   */
  workspaceRoots: readonly string[];
  readOnlyWorkspaceRoots?: readonly string[];
  gitMetadataWritable?: boolean;
  /** The agent's state directory (`config.paths.stateDir`). */
  stateDir?: string;
  /** Configured state files stored outside the main state directory. */
  protectedPaths?: readonly string[];
  network: boolean;
  home?: string;
  tmp?: string;
  nodeExecutable?: string;
  toolchainDirectories?: readonly string[];
}

/**
 * Credential folders and files a command never needs to read to do the
 * user's work. Relative to the home folder.
 */
export const SECRET_HOME_PATHS: readonly string[] = [
  ".ssh",
  ".Xauthority",
  ".aws",
  ".gnupg",
  ".azure",
  ".kube",
  ".docker/config.json",
  ".config/gcloud",
  ".config/gh",
  ".config/hub",
  ".config/op",
  ".netrc",
  ".npmrc",
  ".git-credentials",
  ".pypirc",
  ".password-store",
  ".zsh_history",
  ".bash_history",
  "Library/Keychains",
];

/** The real path when it exists (Seatbelt matches resolved paths). */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** A path as named and, when it resolves elsewhere, as resolved. */
function canonicalFuturePath(path: string): string {
  const parent = dirname(path);
  if (existsSync(path) || parent === path) return real(path);
  return join(canonicalFuturePath(parent), basename(path));
}

function contains(root: string, path: string): boolean {
  const offset = relative(root, path);
  return !isAbsolute(offset) && offset !== ".." && !offset.startsWith(`..${sep}`);
}

function bothSpellings(path: string): string[] {
  const resolved = real(path);
  return resolved === path ? [path] : [path, resolved];
}

function unique(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

/** Recompute metadata on every shell launch, including repositories created since startup. */
function gitMetadata(roots: readonly string[]): string[] {
  const readonly = new Set<string>();
  for (const root of roots.filter(isDirectory)) {
    const pending = [root];
    let visited = 0;
    while (pending.length > 0) {
      if (++visited > 50_000 || readonly.size > 512) {
        // Keep commands usable with a conservative read-only workspace instead
        // of passing an unbounded number of mounts or leaving Git data writable.
        for (const path of readonly) if (contains(root, path)) readonly.delete(path);
        readonly.add(root);
        break;
      }
      const dir = pending.pop()!;
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.name !== ".git") {
            if (entry.isDirectory()) {
              if (entry.name === "node_modules") readonly.add(path);
              else pending.push(path);
            }
            continue;
          }
          const location = real(path);
          if (roots.some(candidate => contains(candidate, location))) readonly.add(location);
          if (entry.isFile() && lstatSync(path).size <= 4096) {
            const pointer = /^gitdir: (.+)/m.exec(readFileSync(path, "utf8"))?.[1]?.trim();
            if (pointer !== undefined) {
              const gitdir = canonicalFuturePath(resolve(dir, pointer));
              if (roots.some(candidate => contains(candidate, gitdir)) && isDirectory(gitdir)) readonly.add(gitdir);
            }
          }
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EACCES" || code === "EPERM") readonly.add(dir);
        else if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      }
    }
  }
  return [...readonly];
}

/** The policy for one command run from the trusted working folders. */
export function buildOsSandboxPolicy(
  input: OsSandboxPolicyInput,
): OsSandboxPolicy {
  const home = real(input.home ?? homedir());
  const tmp = input.tmp ?? tmpdir();
  const work = unique(input.workspaceRoots.map((p) => real(resolve(p))));
  const writableRoots = unique([
    ...work,
    ...(process.platform === "linux" ? [] : [real(tmp)]),
    // `/tmp` is a link to `/private/tmp` on macOS; both spellings.
    ...(process.platform === "darwin" ? ["/tmp", real("/tmp")] : []),
  ]);
  let maskedHomes: string[] = [];
  const secret = SECRET_HOME_PATHS.flatMap((p) => bothSpellings(join(home, p)));
  if (process.platform === "linux") {
    const otherHomes = existsSync("/home") ? readdirSync("/home", { withFileTypes: true })
      .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
      .map(entry => join("/home", entry.name)) : [];
    const accountHomes = readFileSync("/etc/passwd", "utf8").split("\n").flatMap(row => {
      const [, , uid, , , accountHome] = row.split(":");
      return Number(uid) >= 1000 && Number(uid) < 65534 && accountHome && accountHome !== "/" && isAbsolute(accountHome)
        ? [accountHome] : [];
    });
    maskedHomes = unique(["/root", ...otherHomes, ...accountHomes].map(real)).filter(path => path !== home && path !== "/");
    secret.push(...["/etc/shadow", "/etc/gshadow", "/etc/shadow-", "/etc/gshadow-", "/etc/shadow.bak", "/etc/gshadow.bak", "/etc/ssh", "/etc/ssl/private", "/var/backups", "/etc/sudoers", "/etc/sudoers.d", ...maskedHomes].flatMap(bothSpellings));
    if (home === "/root") secret.push("/root");
    const runtime = process.env.XDG_RUNTIME_DIR;
    const sockets = [
      runtime,
      process.getuid === undefined ? undefined : `/run/user/${process.getuid()}`,
      "/run/screen",
      ...(tmp === "/tmp" || tmp === "/" ? [] : [tmp]),
      "/var/run/docker.sock",
      join(home, ".docker/run/docker.sock"),
      process.env.SSH_AUTH_SOCK,
      process.env.DOCKER_HOST?.startsWith("unix://") ? process.env.DOCKER_HOST.slice(7) : undefined,
      runtime === undefined ? undefined : join(runtime, "docker.sock"),
      runtime === undefined ? undefined : join(runtime, "podman/podman.sock"),
    ];
    for (const path of sockets) {
      if (path !== undefined && path !== "/" && isAbsolute(path)) secret.push(...bothSpellings(path));
    }
  }
  const configuredState = input.stateDir ?? process.env.ATOMIC_AGENT_STATE_DIR?.trim();
  const state = configuredState ? resolve(configuredState.replace(/^~(?=\/|$)/, home)) : join(home, ".atomic-agent");
  secret.push(...bothSpellings(state));
  const canonicalState = canonicalFuturePath(state);
  const protectedParents = (input.protectedPaths ?? []).flatMap(path => {
    const canonical = canonicalFuturePath(resolve(path));
    return contains(canonicalState, canonical) ? [] : [canonical, dirname(canonical)];
  });
  for (const path of input.protectedPaths ?? []) {
    const outside = relative(canonicalState, real(resolve(path)));
    if (isAbsolute(outside) || outside === ".." || outside.startsWith(`..${sep}`)) {
      secret.push(...bothSpellings(resolve(path)));
    }
  }
  const denyRead = unique(secret);
  const node = real(input.nodeExecutable ?? process.execPath);
  const nodeDirectory = dirname(node);
  const privateRoots = ["/tmp", "/var/tmp", "/run", home, ...maskedHomes];
  const npmDirectory = join(dirname(nodeDirectory), "lib", "node_modules", "npm");
  const declared = input.toolchainDirectories ?? (process.env.ATOMIC_AGENT_SANDBOX_TOOLCHAINS ?? "").split(delimiter);
  const toolchainRoots = unique([
    privateRoots.some(path => contains(nodeDirectory, path)) ? node : nodeDirectory,
    ...(process.platform === "linux" && isDirectory(npmDirectory) && real(npmDirectory) === npmDirectory ? [npmDirectory] : []),
    ...declared.filter(isAbsolute).map(real).filter(path => !privateRoots.some(root => contains(path, root))),
  ]);
  const readOnlyWorkspaceRoots = unique((input.readOnlyWorkspaceRoots ?? []).map(path => real(resolve(path))));
  return { writableRoots, workspaceRoots: work, readOnlyGitRoots: [], gitMetadataWritable: input.gitMetadataWritable === true, readOnlyWorkspaceRoots, denyRead, network: input.network, stateDir: canonicalState, protectedParents, home, maskedHomes, toolchainRoots };
}

export type OsSandboxWrap =
  | { ok: true; command: string; args: string[] }
  | { ok: false; reason: string };

/** Where `sandbox-exec` lives; a test can point elsewhere. */
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * Mach services that reach outside the box without an IP socket: DNS
 * lookups (a name can carry data out) and LaunchServices (`open URL`
 * hands the URL to a browser that runs unsandboxed). Denied with the
 * network.
 */
const NETWORK_MACH_SERVICES = [
  "com.apple.mDNSResponder",
  "com.apple.dnssd.service",
  "com.apple.coreservices.launchservicesd",
  "com.apple.lsd.mapdb",
  "com.apple.lsd.modifydb",
];

/**
 * The Seatbelt profile. Later rules win, so: allow everything, then
 * deny all writes, re-allow the writable roots, deny the secret reads,
 * and if networking is disabled, deny outbound IP and local-socket traffic, DNS and URL opening, with
 * loopback IP kept. Paths arrive as `(param "...")` values from `-D`,
 * never as text here.
 */
export function buildSeatbeltProfile(policy: OsSandboxPolicy, haveGitExcludes = false): string {
  const lines = ["(version 1)", "(allow default)", "(deny file-write*)"];
  const writable = policy.writableRoots.map(
    (_, i) => `(subpath (param "W${i}"))`,
  );
  lines.push(
    `(allow file-write* ${writable.join(" ")} (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (regex #"^/dev/fd/") (regex #"^/dev/ttys"))`,
  );
  lines.push('(deny file-read* (subpath (param "HOME_ROOT")))');
  const readable = [
    ...policy.writableRoots.map((_, i) => `(subpath (param "W${i}"))`),
    ...policy.readOnlyWorkspaceRoots.map((_, i) => `(subpath (param "I${i}"))`),
    ...policy.toolchainRoots.map((_, i) => `(subpath (param "T${i}"))`),
  ];
  if (readable.length > 0) lines.push(`(allow file-read* ${readable.join(" ")})`);
  if (policy.readOnlyWorkspaceRoots.length > 0) {
    lines.push(`(deny file-write* ${policy.readOnlyWorkspaceRoots.map((_, i) => `(subpath (param "I${i}"))`).join(" ")})`);
  }
  if (policy.readOnlyGitRoots.length > 0) {
    lines.push(`(deny file-write* ${policy.readOnlyGitRoots.map((_, i) => `(subpath (param "G${i}"))`).join(" ")})`);
  }
  if (haveGitExcludes) {
    lines.push('(allow file-read* (literal (param "GIT_EXCLUDES")))',
      '(deny file-write* (literal (param "GIT_EXCLUDES")))');
  }
  if (policy.denyRead.length > 0) {
    const denied = policy.denyRead.map((_, i) => `(subpath (param "R${i}"))`);
    lines.push(`(deny file-read* file-write* ${denied.join(" ")})`);
  }
  lines.push('(deny appleevent-send)',
    '(deny mach-lookup (global-name "com.apple.launchd") (global-name "com.apple.securityd") (global-name "com.apple.pasteboard.1") (global-name "com.apple.coreservices.launchservicesd") (global-name "com.apple.lsd.mapdb") (global-name "com.apple.lsd.modifydb"))',
    '(deny network-outbound (remote unix-socket))');
  if (!policy.network) {
    lines.push('(deny network-outbound (remote ip "*:*") (remote unix-socket))');
    lines.push('(allow network-outbound (remote ip "localhost:*"))');
    const services = NETWORK_MACH_SERVICES.map((n) => `(global-name "${n}")`);
    lines.push(`(deny mach-lookup ${services.join(" ")})`);
  }
  return lines.join("\n");
}

function seatbeltArgs(
  policy: OsSandboxPolicy,
  command: string,
  args: readonly string[],
  cwd?: string,
): string[] {
  const excludes = cwd === undefined ? undefined : resolveSandboxGitExcludes(cwd, policy);
  const params: string[] = ["-D", `HOME_ROOT=${policy.home}`];
  policy.readOnlyWorkspaceRoots.forEach((dir, i) => params.push("-D", `I${i}=${dir}`));
  policy.toolchainRoots.forEach((dir, i) => params.push("-D", `T${i}=${dir}`));
  policy.writableRoots.forEach((dir, i) => params.push("-D", `W${i}=${dir}`));
  policy.readOnlyGitRoots.forEach((dir, i) => params.push("-D", `G${i}=${dir}`));
  policy.denyRead.forEach((dir, i) => params.push("-D", `R${i}=${dir}`));
  if (excludes === undefined) return [...params, "-p", buildSeatbeltProfile(policy), command, ...args];
  params.push("-D", `GIT_EXCLUDES=${excludes.source}`);
  const profile = [...params, "-p", buildSeatbeltProfile(policy, true)];
  if (excludes.source === excludes.destination) return [...profile, command, ...args];
  // Seatbelt cannot alias a file. Write a minimal Git config in the per-command
  // cache, then exec to preserve the original child's signal and I/O behavior.
  const bootstrap = [
    'set -eu', 'umask 077', '/bin/mkdir -p "$XDG_CACHE_HOME"',
    'config=$(/usr/bin/mktemp "$XDG_CACHE_HOME/git-config.XXXXXX")',
    'printf "%s\n" "$1" > "$config"', '/bin/chmod 400 "$config"',
    'export GIT_CONFIG_GLOBAL="$config"', 'shift', 'exec "$@"',
  ].join("\n");
  return [...profile, "/bin/sh", "-c", bootstrap, "atomic-git-excludes",
    `[core]\nexcludesFile = ${JSON.stringify(excludes.source)}`, command, ...args];
}

const SYSTEM_BWRAP_PATHS = [
  "/usr/bin/bwrap",
  "/bin/bwrap",
  "/usr/local/bin/bwrap",
  "/run/wrappers/bin/bwrap",
  "/run/current-system/sw/bin/bwrap",
];

/** Launch only a system-managed backend, never a binary supplied by a project's PATH. */
export function findBwrap(): string | null {
  for (const path of SYSTEM_BWRAP_PATHS) {
    try {
      const backend = realpathSync(path);
      accessSync(backend, constants.X_OK);
      if (!statSync(backend).isFile()) continue;
      let trusted = true;
      for (let target = backend; ; target = dirname(target)) {
        const info = statSync(target);
        if (info.uid !== 0 || (info.mode & 0o022) !== 0) {
          trusted = false;
          break;
        }
        if (dirname(target) === target) break;
      }
      if (trusted) return backend;
    } catch {
      // Continue to the next system installation path.
    }
  }
  return null;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const LINUX_SYSTEM_TREES = [
  "/usr/bin", "/usr/sbin", "/usr/lib", "/usr/lib32", "/usr/lib64", "/usr/libx32", "/usr/libexec",
  "/usr/share", "/nix/store",
];
const LINUX_BROAD_ROOTS = ["/usr", "/usr/local", "/etc", "/var", "/srv", "/mnt", "/media", "/opt", "/nix"];
const LINUX_SYSTEM_ALIASES = ["/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32"];
const LINUX_ETC_ENTRIES = [
  "/etc/ld.so.cache", "/etc/passwd", "/etc/group", "/etc/nsswitch.conf",
  "/etc/hosts", "/etc/host.conf", "/etc/gai.conf", "/etc/localtime",
  "/etc/ssl/certs", "/etc/pki/ca-trust/extracted",
];

/** Report host sockets and directories whose contents we cannot inventory. */
function maskingMounts(root: string, system: boolean): string[][] {
  const masks: string[][] = [];
  const pending = [root];
  while (pending.length > 0) {
    const path = pending.pop()!;
    try {
      const info = lstatSync(path);
      if (info.isSocket()) masks.push(["--ro-bind", "/dev/null", path]);
      if (!info.isDirectory()) continue;
      if (system && (info.mode & 0o022) !== 0) {
        masks.push(["--tmpfs", path], ["--remount-ro", path]);
        continue;
      }
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const entryPath = join(path, entry.name);
        if (entry.isDirectory()) pending.push(entryPath);
        else if (entry.isSocket()) masks.push(["--ro-bind", "/dev/null", entryPath]);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") masks.push(["--tmpfs", path], ["--remount-ro", path]);
      else if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
  }
  return masks;
}

/** Reconstruct only the system trees and public configuration used by tools. */
function linuxSystemMounts(out: string[]): string[] {
  const trees: string[] = [];
  for (const path of LINUX_SYSTEM_TREES) {
    if (real(path) !== path || !isDirectory(path)) continue;
    out.push("--ro-bind", path, path);
    trees.push(path);
  }
  for (const path of LINUX_SYSTEM_ALIASES) {
    if (!isDirectory(path)) continue;
    const source = real(path);
    if (source === path) {
      out.push("--ro-bind", path, path);
      trees.push(path);
    } else if (trees.some(tree => contains(tree, source))) {
      out.push("--symlink", source, path);
    }
  }
  for (const path of LINUX_ETC_ENTRIES) {
    const source = real(path);
    if (source !== path && !trees.some(tree => contains(tree, source))) continue;
    if (!existsSync(source)) continue;
    const info = statSync(source);
    if (info.isFile() || info.isDirectory()) {
      out.push("--ro-bind", source, path);
      if (info.isDirectory()) trees.push(path);
    }
  }
  return trees;
}

/** Read only the operator's global ignore setting, using the system Git binary. */
export function resolveSandboxGitExcludes(cwd: string, policy: OsSandboxPolicy): { source: string; destination: string } | undefined {
  const home = homedir();
  const xdg = process.env.XDG_CONFIG_HOME;
  const destination = join(xdg && isAbsolute(xdg) ? xdg : join(home, ".config"), "git", "ignore");
  const globalConfig = process.env.GIT_CONFIG_GLOBAL;
  const result = spawnSync("/usr/bin/git", ["config", "--global", "--includes", "--path", "--null", "--get", "core.excludesFile"], {
    cwd, encoding: "utf8", timeout: 500, maxBuffer: 64 * 1024,
    env: { PATH: "/usr/bin:/bin", HOME: home, XDG_CONFIG_HOME: xdg, GIT_CONFIG_GLOBAL: globalConfig },
  });
  const configured = result.status === 0 ? (result.stdout ?? "").replace(/\0$/, "") : destination;
  if (configured === "") return undefined;
  const source = real(resolve(cwd, configured));
  if (/[\u0000-\u001f]/.test(source) || basename(source) === ".gitconfig" || source === real(join(dirname(destination), "config")) ||
    (globalConfig !== undefined && source === real(resolve(cwd, globalConfig))) ||
    policy.denyRead.some(path => path !== policy.home && contains(path, source)) ||
    ["/etc", "/proc", "/dev", "/sys", "/run"].some(path => contains(path, source)) ||
    ["/proc", "/dev", "/sys", "/run", "/etc", "/usr", "/bin", "/lib", "/var"].some(path => contains(path, destination))) {
    return undefined;
  }
  try {
    const info = lstatSync(source);
    if (info.isFile() && info.size <= 8 * 1024 * 1024) return { source, destination };
  } catch {
    // Git treats a missing or unreadable ignore file as empty.
  }
  return undefined;
}

/** Mount the workspace before read-only overlays, then mask host endpoints. */
function bwrapArgs(
  policy: OsSandboxPolicy,
  command: string,
  args: readonly string[],
  cwd?: string,
  disableUserns = false,
): string[] {
  const out = ["--dev", "/dev", "--unshare-pid", "--unshare-ipc", "--unshare-user", "--cap-drop", "ALL"];
  const systemMounts = linuxSystemMounts(out);
  if (disableUserns) out.push("--disable-userns");
  out.push("--tmpfs", policy.home, "--tmpfs", "/tmp", "--tmpfs", "/run", "--tmpfs", "/run/lock", "--tmpfs", "/var/tmp");
  if (real("/var/run") === "/run") out.push("--symlink", "../run", "/var/run");
  else out.push("--tmpfs", "/var/run");
  // Expose only the resolver contents, never the host runtime directory.
  const resolver = real("/etc/resolv.conf");
  if (policy.network && (resolver === "/etc/resolv.conf" || resolver.startsWith("/run/systemd/resolve/")) &&
    existsSync(resolver) && statSync(resolver).isFile()) {
    out.push("--ro-bind", resolver, "/etc/resolv.conf");
  }
  const homeMasks = unique([policy.home, ...policy.maskedHomes]);
  for (const path of homeMasks) if (path !== policy.home && isDirectory(path)) out.push("--tmpfs", path);
  for (const dir of unique(policy.writableRoots.map(real))) {
    if (dir === "/tmp") continue;
    // An absent directory cannot be bound.
    if (existsSync(dir)) out.push("--bind", dir, dir);
  }
  for (const dir of policy.toolchainRoots) out.push("--ro-bind", dir, dir);
  for (const path of policy.readOnlyWorkspaceRoots) out.push("--ro-bind", path, path);
  for (const path of policy.readOnlyGitRoots) out.push("--ro-bind", path, path);
  const exposed = unique([...systemMounts, ...policy.toolchainRoots, ...policy.writableRoots, ...policy.readOnlyWorkspaceRoots])
    .filter(path => path !== "/tmp" && path !== "/var/tmp" && path !== "/run");
  for (const path of exposed.filter(path => !exposed.some(other => other !== path && contains(other, path)))) {
    for (const mount of maskingMounts(path, systemMounts.includes(path))) out.push(...mount);
  }
  for (const line of readFileSync("/proc/self/mountinfo", "utf8").split("\n")) {
    const mount = line.split(" ")[4]?.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
    if (mount === undefined || !systemMounts.some(path => mount !== path && contains(path, mount))) continue;
    if (isDirectory(mount)) out.push("--tmpfs", mount, "--remount-ro", mount);
    else if (existsSync(mount)) out.push("--ro-bind", "/dev/null", mount);
  }
  out.push("--proc", "/proc");
  for (const path of unique(policy.denyRead.map(real))) {
    if (homeMasks.includes(path) || !existsSync(path)) continue;
    if (isDirectory(path)) out.push("--tmpfs", path, "--remount-ro", path);
    else out.push("--ro-bind", "/dev/null", path);
  }
  const excludes = cwd === undefined ? undefined : resolveSandboxGitExcludes(cwd, policy);
  if (excludes !== undefined && !policy.denyRead.some(path => path !== policy.home && contains(path, excludes.destination))) {
    out.push("--ro-bind", excludes.source, excludes.destination);
  }
  if (!policy.network) out.push("--unshare-net");
  if (cwd !== undefined) out.push("--chdir", cwd);
  out.push("--remount-ro", "/", "--die-with-parent", "--new-session", "--", command, ...args);
  return out;
}

export interface WrapOptions {
  platform?: NodeJS.Platform;
  /** `bwrap` path for Linux; looked up in system locations when omitted. */
  bwrap?: string | null;
  /** Whether `sandbox-exec` exists; checked when omitted. */
  seatbeltAvailable?: boolean;
  cwd?: string;
  disableUsernsAvailable?: boolean;
}

/**
 * The spawn for `command args` inside the sandbox, or why there is none
 * on this machine. The caller decides what to do without one.
 */
let warnedAboutRoot = false;
const usernsSupport = new Map<string, boolean>();
function supportsDisableUserns(backend: string): boolean {
  const cached = usernsSupport.get(backend);
  if (cached !== undefined) return cached;
  const probe = spawnSync(backend, ["--help"], { encoding: "utf8", timeout: 2000 });
  const supported = probe.status === 0 && (probe.stdout ?? "").includes("--disable-userns");
  usernsSupport.set(backend, supported);
  return supported;
}

export function wrapWithOsSandbox(
  command: string,
  args: readonly string[],
  policy: OsSandboxPolicy,
  options: WrapOptions = {},
): OsSandboxWrap {
  const platform = options.platform ?? process.platform;
  const cwd = options.cwd === undefined ? undefined : canonicalFuturePath(resolve(options.cwd));
  if (cwd !== undefined && !policy.workspaceRoots.some(root => contains(root, cwd))) {
    return { ok: false, reason: "the working directory is outside the authorized workspace" };
  }
  if (policy.writableRoots.some(root => {
    return [policy.home, ...policy.maskedHomes].some(home => contains(root, home));
  })) {
    return { ok: false, reason: "a writable workspace root would expose the full host home directory" };
  }
  if (policy.writableRoots.some(root => {
    return contains(root, policy.stateDir) || contains(policy.stateDir, root);
  })) {
    return { ok: false, reason: "the protected agent state overlaps a writable workspace root" };
  }
  if (policy.writableRoots.some(root => policy.protectedParents.some(path => contains(root, path) || contains(path, root)))) {
    return { ok: false, reason: "a configured protected path overlaps a writable workspace root" };
  }
  if (policy.readOnlyWorkspaceRoots.some(root => [policy.home, ...policy.maskedHomes].some(home => contains(root, home)) || contains(root, policy.stateDir) ||
    contains(policy.stateDir, root) || policy.protectedParents.some(path => contains(root, path) || contains(path, root)))) {
    return { ok: false, reason: "a read-only input root overlaps protected host data" };
  }
  if (platform === "linux" && [...policy.writableRoots, ...policy.readOnlyWorkspaceRoots, ...policy.toolchainRoots]
    .some(root => LINUX_BROAD_ROOTS.some(path => contains(root, path)))) {
    return { ok: false, reason: "a workspace or toolchain root would reopen a broad host filesystem tree" };
  }
  if (platform === "linux" && policy.writableRoots.some(root =>
    [...LINUX_SYSTEM_TREES, ...LINUX_SYSTEM_ALIASES, ...LINUX_ETC_ENTRIES]
      .some(path => contains(root, path) || contains(path, root)))) {
    return { ok: false, reason: "a writable workspace root overlaps a system filesystem mount" };
  }
  const applyGitProtection = (): OsSandboxPolicy => policy.gitMetadataWritable ? policy : {
    ...policy,
    readOnlyGitRoots: gitMetadata(policy.workspaceRoots),
  };
  if (platform === "darwin") {
    const available = options.seatbeltAvailable ?? existsSync(SANDBOX_EXEC);
    if (!available) {
      return { ok: false, reason: `${SANDBOX_EXEC} is missing on this Mac` };
    }
    return { ok: true, command: SANDBOX_EXEC, args: seatbeltArgs(applyGitProtection(), command, args, cwd) };
  }
  if (platform === "linux") {
    const bwrap = options.bwrap === undefined ? findBwrap() : options.bwrap;
    if (bwrap === null) {
      return {
        ok: false,
        reason: "no system-managed bubblewrap (`bwrap`) was found; install it with your package manager (for example `sudo apt install bubblewrap`)",
      };
    }
    if (process.getuid?.() === 0 && !warnedAboutRoot) {
      warnedAboutRoot = true;
      process.emitWarning("Safe Mode is running with host UID 0. Run the agent as an ordinary user where possible.", { code: "ATOMIC_AGENT_SANDBOX_ROOT" });
    }
    return { ok: true, command: bwrap, args: bwrapArgs(applyGitProtection(), command, args, cwd, options.disableUsernsAvailable ?? supportsDisableUserns(bwrap)) };
  }
  return {
    ok: false,
    reason: "the command sandbox is not available on Windows yet",
  };
}

/**
 * The one-line refusal when the sandbox is on but cannot run here.
 * Says how to turn it off, so the person is never stuck.
 */
export function formatSandboxUnavailable(reason: string): string {
  return (
    `Safe Mode is on, but the command sandbox cannot run here: ${reason}. ` +
    `The command was not run. To run commands without the sandbox, unset ${SANDBOX_MODE_ENV} (or set it to "off") and restart the agent.`
  );
}
