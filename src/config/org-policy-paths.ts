import { join, posix, win32, resolve } from "node:path";
import { homedir } from "node:os";

export const POLICY_STATE_DIR_ENV = "ATOMIC_AGENT_POLICY_STATE_DIR";
export const POLICY_SYSTEM_PATH_ENV = "ATOMIC_AGENT_POLICY_SYSTEM_PATH";
export const POLICY_FILE_PINS_ENV = "ATOMIC_AGENT_POLICY_FILE_PINS";
export function inheritedPolicyStateDir(env: NodeJS.ProcessEnv): string {
  const path = env[POLICY_STATE_DIR_ENV] ?? env.ATOMIC_AGENT_STATE_DIR ?? "~/.atomic-agent";
  return resolve(path.replace(/^~(?=$|[\\/])/, homedir()));
}

/** Shared with the secret/trust boundary, below the policy evaluator. */
export function systemPolicyPath(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === "darwin") return "/Library/Application Support/AtomicAgent/policy.json";
  if (platform === "win32") return win32.join(env.ProgramData ?? "C:\\ProgramData", "AtomicAgent", "policy.json");
  return posix.join("/etc", "atomic-agent", "policy.json");
}

export function orgPolicyPaths(stateDir: string): readonly string[] {
  const roots = new Set([stateDir, ...(process.env[POLICY_STATE_DIR_ENV] ? [inheritedPolicyStateDir(process.env)] : [])]);
  let pins: string[] = [];
  try {
    const values: unknown = JSON.parse(process.env[POLICY_FILE_PINS_ENV] ?? "[]");
    if (Array.isArray(values) && values.length <= 64) pins = values.flatMap(pin => pin && typeof pin.path === "string" ? [pin.path] : []);
  } catch { /* The child loader refuses malformed metadata before tool use. */ }
  return [...[...roots].flatMap(root => [join(root, "policy.json"), join(root, "policy-cache.json")]), ...pins, systemPolicyPath(process.platform, process.env), ...(process.env[POLICY_SYSTEM_PATH_ENV] ? [process.env[POLICY_SYSTEM_PATH_ENV]!] : [])];
}
