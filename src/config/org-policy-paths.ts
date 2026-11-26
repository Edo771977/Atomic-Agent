import { join, posix, win32, resolve } from "node:path";
import { homedir } from "node:os";

export const POLICY_STATE_DIR_ENV = "ATOMIC_AGENT_POLICY_STATE_DIR";
export const POLICY_SYSTEM_PATH_ENV = "ATOMIC_AGENT_POLICY_SYSTEM_PATH";
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
  return [...[...roots].flatMap(root => [join(root, "policy.json"), join(root, "policy-cache.json")]), systemPolicyPath(process.platform, process.env), ...(process.env[POLICY_SYSTEM_PATH_ENV] ? [process.env[POLICY_SYSTEM_PATH_ENV]!] : [])];
}
