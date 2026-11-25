import { join, posix, win32 } from "node:path";

/** Shared with the secret/trust boundary, below the policy evaluator. */
export function systemPolicyPath(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === "darwin") return "/Library/Application Support/AtomicAgent/policy.json";
  if (platform === "win32") return win32.join(env.ProgramData ?? "C:\\ProgramData", "AtomicAgent", "policy.json");
  return posix.join("/etc", "atomic-agent", "policy.json");
}

export function orgPolicyPaths(stateDir: string): readonly string[] {
  return [join(stateDir, "policy.json"), join(stateDir, "policy-cache.json"), systemPolicyPath(process.platform, process.env)];
}
