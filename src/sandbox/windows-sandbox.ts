import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { isSea } from "node:sea";
import { fileURLToPath } from "node:url";
import type { OsSandboxPolicy, OsSandboxWrap } from "./os-sandbox.js";
import { projectDecisionOriginRefusal } from "./project-decision-origin.js";
import { windowsSystemExecutable } from "./windows-system-executable.js";

const INSTALL_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DEVELOPMENT_HELPER = "ATOMIC_AGENT_WINDOWS_SANDBOX_HELPER";
const REGRANT = "reopen the project in the TUI to grant Windows sandbox access";
const PROFILE_PREFIX = "AtomicAgent.Workspace.";
const VERSION = 1;

interface Grant {
  root: string;
  profile: string;
  sid: string | null;
  readOnlyRoots: string[];
  date: string;
  version: number;
  status: "pending" | "granted";
}

export interface WindowsSandboxPlan {
  state: string;
  root: string;
  helper: string;
  profile: string;
  readOnlyRoots: string[];
  approximateFiles: number;
}

function absoluteLocal(path: string): boolean {
  return /^[a-z]:\\[^\\]/i.test(path) && !/[:*?"<>|/\u0000-\u001f]/.test(path.slice(2));
}

function canonical(path: string): string {
  const real = realpathSync.native(path);
  if (!absoluteLocal(real)) throw new Error("Windows sandbox requires a local drive path with persistent ACLs");
  return real;
}

function inside(root: string, path: string): boolean {
  const offset = win32.relative(root, path);
  return !win32.isAbsolute(offset) && offset !== ".." && !offset.startsWith("..\\");
}

function overlaps(left: string, right: string): boolean {
  return inside(left, right) || inside(right, left);
}

function sandboxHelper(): string {
  const override = process.env[DEVELOPMENT_HELPER];
  if (override !== undefined && !absoluteLocal(override)) throw new Error(`${DEVELOPMENT_HELPER} requires an absolute local path`);
  const installed = isSea() ? join(dirname(process.execPath), "atomic-sandbox-helper.exe") :
    join(INSTALL_ROOT, "native", "windows-sandbox-helper", "atomic-sandbox-helper.exe");
  const selected = override ?? installed;
  if (lstatSync(selected).isSymbolicLink()) throw new Error("Windows sandbox helper cannot be a link");
  return canonical(selected);
}

function stateFolder(state: string): string {
  const folder = join(state, "windows-sandbox");
  if (existsSync(folder) && (lstatSync(folder).isSymbolicLink() || canonical(folder).toLowerCase() !== folder.toLowerCase())) {
    throw new Error("Windows sandbox state folder must be a local directory without links");
  }
  return folder;
}

function initState(state: string, helper: string): string {
  const folder = stateFolder(state);
  const result = spawnSync(helper, ["init-state", state, folder], {
    cwd: dirname(helper), env: {}, windowsHide: true, encoding: "utf8", timeout: 5000,
  });
  if (result.status !== 0) throw new Error(result.stderr?.trim() || "cannot prepare private Windows sandbox state");
  return folder;
}

function grantsPath(state: string): string {
  return join(stateFolder(state), "grants.json");
}

function readGrants(state: string): Grant[] {
  const file = grantsPath(state);
  if (!existsSync(file)) return [];
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(value) || !value.every((grant: Grant) =>
    typeof grant === "object" && grant !== null && grant.version === VERSION &&
    absoluteLocal(grant.root) && grant.profile === getProfile(grant.root) &&
    (grant.sid === null || /^S-1-15-2(?:-\d+)+$/.test(grant.sid)) &&
    typeof grant.date === "string" && Array.isArray(grant.readOnlyRoots) &&
    grant.readOnlyRoots.every(path => typeof path === "string" && absoluteLocal(path)) &&
    (grant.status === "pending" || grant.status === "granted"))) {
    throw new Error("Windows sandbox grant registry is invalid");
  }
  return value;
}

function writeGrants(state: string, grants: Grant[]): void {
  const file = grantsPath(state);
  const temporary = file + "." + randomUUID() + ".tmp";
  try {
    writeFileSync(temporary, JSON.stringify(grants, null, 2) + "\n", { flag: "wx", flush: true });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function getProfile(root: string): string {
  return PROFILE_PREFIX + createHash("sha256").update(root.toLowerCase()).digest("hex").slice(0, 32);
}

function withRegistryLock<T>(state: string, operation: () => T): T {
  const path = join(stateFolder(state), "operator.lock");
  try {
    mkdirSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Another grant or revocation holds the Windows sandbox registry lock");
    throw error;
  }
  try {
    return operation();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}

function requireOperator(): void {
  const refusal = projectDecisionOriginRefusal();
  if (refusal !== undefined) throw new Error(refusal);
  if (process.platform !== "win32") throw new Error("Windows sandbox grants require Windows");
}

function rootProtected(root: string, state: string, helper: string): boolean {
  const module = isSea() ? process.execPath : INSTALL_ROOT;
  return overlaps(root, state) || inside(root, homedir()) || overlaps(root, dirname(helper)) ||
    inside(root, process.execPath) || overlaps(root, module);
}

function runtimeRoots(helper: string): string[] {
  const configured = (process.env.ATOMIC_AGENT_SANDBOX_TOOLCHAINS ?? "").split(";").filter(Boolean);
  return [...new Set([helper, ...configured.map(canonical)])];
}

function scanProject(root: string, countLimit: number): { count: number; probe?: string } {
  const pending = [root];
  let count = 0;
  let probe: string | undefined;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      if (entry.isFile()) {
        ++count;
        probe ??= path;
        if (count >= countLimit) return { count, probe };
      }
    }
  }
  return { count, probe };
}

/** Gather details for the operator prompt. This step only reads the workspace. */
export function planWindowsSandbox(statePath: string, rootPath: string, protectedPaths: readonly string[]): WindowsSandboxPlan | undefined {
  requireOperator();
  mkdirSync(statePath, { recursive: true });
  const state = canonical(statePath);
  const root = canonical(rootPath);
  const helper = sandboxHelper();
  if (rootProtected(root, state, helper)) throw new Error("Windows sandbox project overlaps protected state, the user profile, or the agent installation");

  const profile = getProfile(root);
  const readOnlyRoots = runtimeRoots(helper);
  if ([root, ...readOnlyRoots].some(path => protectedPaths.some(secret => overlaps(path, secret)))) {
    throw new Error("Windows sandbox project or runtime overlaps a protected file");
  }
  const recorded = readGrants(state).find(grant => grant.profile === profile);
  if (recorded?.status === "granted" && JSON.stringify(recorded.readOnlyRoots) === JSON.stringify(readOnlyRoots) &&
    probeWindowsSandbox(root, state)) return undefined;

  const approximateFiles = scanProject(root, 50001).count;
  if (approximateFiles === 0) throw new Error("The Windows sandbox needs an existing project file for its launch probe");
  return { state, root, helper, profile, readOnlyRoots, approximateFiles };
}

function changeAcl(plan: Omit<WindowsSandboxPlan, "approximateFiles">, operation: "grant" | "revoke"): string {
  const result = spawnSync(plan.helper, [operation, plan.profile, plan.state, plan.root, ...plan.readOnlyRoots], {
    cwd: dirname(plan.helper), windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 600_000,
  });
  const details = result.stdout?.trim();
  if (result.status !== 0 || details === undefined) throw new Error(`Windows sandbox ${operation} failed${details ? ` (${details})` : ""}`);
  const sid = details.split("\t")[0];
  if (sid === undefined || !/^S-1-15-2(?:-\d+)+$/.test(sid)) throw new Error("Windows sandbox helper returned an invalid SID");
  return sid;
}

export function applyWindowsSandboxGrant(plan: WindowsSandboxPlan): void {
  requireOperator();
  initState(plan.state, plan.helper);
  withRegistryLock(plan.state, () => {
    const grants = readGrants(plan.state);
    const previous = grants.find(grant => grant.profile === plan.profile);
    if (previous !== undefined && JSON.stringify(previous.readOnlyRoots) !== JSON.stringify(plan.readOnlyRoots)) {
      throw new Error("revoke the existing Windows sandbox grant before changing its runtime roots");
    }
    const roots = plan.readOnlyRoots;
    const remaining = grants.filter(grant => grant.profile !== plan.profile);
    const pending: Grant = {
      root: plan.root, profile: plan.profile, sid: previous?.sid ?? null, readOnlyRoots: roots,
      date: new Date().toISOString(), version: VERSION, status: "pending",
    };
    writeGrants(plan.state, [...remaining, pending]);
    const sid = changeAcl({ ...plan, readOnlyRoots: roots }, "grant");
    writeGrants(plan.state, [...remaining, { ...pending, sid, status: "granted" }]);
    if (!probeWindowsSandbox(plan.root, plan.state)) {
      writeGrants(plan.state, [...remaining, { ...pending, sid }]);
      throw new Error("the Windows launch probe failed after granting access; the CLI will refuse commands");
    }
  });
}

export function revokeWindowsSandbox(statePath: string, selection: string | "--all"): number {
  requireOperator();
  if (!existsSync(statePath)) return 0;
  const state = canonical(statePath);
  const selected = selection === "--all" ? undefined : existsSync(selection) ? canonical(selection) : win32.resolve(selection);
  if (readGrants(state).length === 0) return 0;
  const helper = sandboxHelper();
  initState(state, helper);
  return withRegistryLock(state, () => {
    let grants = readGrants(state);
    let removed = 0;
    for (const grant of grants.filter(entry => selected === undefined || entry.root.toLowerCase() === selected.toLowerCase())) {
      // Mark the entry pending before touching ACLs. An interruption can be retried.
      grants = grants.map(entry => entry.profile === grant.profile ? { ...entry, status: "pending" } : entry);
      writeGrants(state, grants);
      const sid = changeAcl({ state, helper, ...grant }, "revoke");
      if (grant.sid !== null && grant.sid !== sid) throw new Error("Windows sandbox profile SID changed during revocation");
      grants = grants.filter(entry => entry.profile !== grant.profile);
      writeGrants(state, grants);
      ++removed;
    }
    return removed;
  });
}

function resolveCommand(command: string, grant: Grant, cwd: string): string {
  if (absoluteLocal(command)) return canonical(command);
  if (command.includes("\\") || command.includes("/")) return canonical(win32.resolve(cwd, command));
  const executable = command.toLowerCase().endsWith(".exe") ? command : command + ".exe";
  if (executable.toLowerCase() === "cmd.exe") return canonical(windowsSystemExecutable("cmd.exe"));
  for (const root of grant.readOnlyRoots) {
    if (lstatSync(root).isDirectory()) {
      const path = join(root, executable);
      if (existsSync(path)) return canonical(path);
    } else if (win32.basename(root).toLowerCase() === executable.toLowerCase()) {
      return root;
    }
  }
  throw new Error(`executable is outside the approved Windows sandbox runtime roots: ${command}`);
}

interface WindowsLaunch {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  verbatim?: boolean;
  protectedPaths?: readonly string[];
}

function createWindowsLaunch(command: string, args: readonly string[], root: string, state: string, options: WindowsLaunch): OsSandboxWrap {
  try {
    state = canonical(state);
    root = canonical(root);
    const helper = sandboxHelper();
    const grant = readGrants(state).filter(entry => inside(entry.root, root))
      .sort((left, right) => right.root.length - left.root.length)[0];
    if (grant?.status !== "granted" || !grant.readOnlyRoots.some(path => path.toLowerCase() === helper.toLowerCase())) {
      return { ok: false, reason: `Windows sandbox grant is missing or incomplete; ${REGRANT}` };
    }
    if (rootProtected(grant.root, state, helper) || [grant.root, ...grant.readOnlyRoots].some(path =>
      options.protectedPaths?.some(secret => overlaps(path, secret)))) {
      return { ok: false, reason: "Windows sandbox grant overlaps protected data or the agent installation" };
    }
    const cwd = canonical(options.cwd);
    if (!inside(root, cwd)) return { ok: false, reason: "working directory is outside the approved Windows sandbox project" };
    const projectFile = scanProject(root, 1).probe;
    if (!projectFile) return { ok: false, reason: `Windows sandbox could not find an existing project file; ${REGRANT}` };
    const executable = resolveCommand(command, grant, cwd);
    const folder = initState(state, helper);
    const workspaceTemp = mkdtempSync(join(folder, "run-"));
    const privateTemp = join(workspaceTemp, "temp");
    mkdirSync(privateTemp);
    const outsideCanary = join(workspaceTemp, "outside");
    const file = join(workspaceTemp, "request.json");
    writeFileSync(outsideCanary, "Atomic Agent Windows sandbox probe\n", { flag: "wx" });
    const env = Object.fromEntries(Object.entries(options.env ?? {}).filter(([name, value]) =>
      /^(?:LANG|LC_ALL|NO_COLOR|TERM)$/.test(name) && value !== undefined));
    writeFileSync(file, JSON.stringify({
      profile: grant.profile, cwd, state, privateTemp, projectFile, outsideCanary,
      argv: [executable, ...args], writableRoots: [grant.root], readOnlyRoots: grant.readOnlyRoots,
      env, timeoutMs: options.timeoutMs !== undefined && options.timeoutMs > 0 ? Math.min(Math.floor(options.timeoutMs), 0xfffffffe) : 0,
      verbatim: options.verbatim === true ? 1 : 0,
    }), { flag: "wx", encoding: "utf16le" });
    return { ok: true, command: helper, args: ["run", file], windowsVerbatimArguments: false, helperCwd: dirname(helper) };
  } catch (error) {
    return { ok: false, reason: `Windows sandbox is unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function wrapWindowsSandbox(command: string, args: readonly string[], policy: OsSandboxPolicy, options: WindowsLaunch): OsSandboxWrap {
  if (policy.network) return { ok: false, reason: "the Windows sandbox denies all networking, including one-time requests" };
  const root = policy.workspaceRoots[0];
  if (root === undefined || policy.workspaceRoots.length !== 1 || policy.readOnlyWorkspaceRoots.length > 0) {
    return { ok: false, reason: "Windows sandbox requires a single approved project root" };
  }
  if (policy.denyRead.some(path => overlaps(root, path))) {
    return { ok: false, reason: "Windows sandbox project overlaps a protected credential path" };
  }
  return createWindowsLaunch(command, args, root, policy.stateDir, { ...options, protectedPaths: policy.denyRead });
}

export function probeWindowsSandbox(root: string, state: string): boolean {
  // A native probe runs before this harmless command. Its exit status is also
  // checked before treating a stored ACL grant as current in the TUI.
  const command = windowsSystemExecutable("cmd.exe");
  const wrapped = createWindowsLaunch(command, ["/d", "/c", "exit", "0"], root, state, { cwd: root, timeoutMs: 5000 });
  if (!wrapped.ok) return false;
  const result = spawnSync(wrapped.command, wrapped.args, { cwd: wrapped.helperCwd ?? root, env: {}, windowsHide: true, timeout: 12_000 });
  return result.status === 0;
}

export function hasWindowsSandboxGrants(statePath: string): boolean {
  return process.platform === "win32" && existsSync(statePath) && readGrants(canonical(statePath)).length > 0;
}
