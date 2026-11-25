import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { EffectivePolicy } from "./policy-evaluator.js";

export function canonicalPolicyPath(path: string): string {
  try { return realpathSync(path); } catch {
    const parent = dirname(path);
    return parent === path ? path : resolve(canonicalPolicyPath(parent), basename(path));
  }
}

export function policyFilePaths(policy: EffectivePolicy): string[] {
  return policy.sources.filter(source => source.kind !== "url").flatMap(source =>
    source.kind === "user" ? [source.location, join(dirname(source.location), "policy-cache.json")] : [source.location]);
}

/** One read operation: canonicalize each path once, without retaining decisions across calls. */
export function policyFileReadFilter(policy: EffectivePolicy) {
  const canonical = new Map<string, string>();
  const key = (path: string): string => {
    const absolute = resolve(path);
    let value = canonical.get(absolute);
    if (value === undefined) {
      value = canonicalPolicyPath(absolute);
      if (process.platform === "win32" || process.platform === "darwin") value = value.toLowerCase();
      canonical.set(absolute, value);
    }
    return value;
  };
  const files = policyFilePaths(policy);
  const protectedKeys = new Set(files.map(key));
  return { files, allows: (path: string) => !protectedKeys.has(key(path)) };
}
