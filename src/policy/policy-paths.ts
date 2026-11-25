import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve, relative, isAbsolute, posix, win32 } from "node:path";
import { homedir } from "node:os";
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

/** Patterns and resources share one identity; caches last only for this evaluation. */
export function createEditPathNormalizer(workingDir = process.cwd(), platform: NodeJS.Platform = process.platform,
  canonicalize: (path: string) => string = platform === process.platform ? canonicalPolicyPath : path => path) {
  const api = platform === "win32" ? win32 : posix;
  const cache = new Map<string, string>();
  const fold = (value: string) => {
    const path = value.replace(/\\/g, "/");
    return platform === "win32" || platform === "darwin" ? path.toLowerCase() : path;
  };
  const path = (value: string): string => {
    const expanded = value.replace(/^~(?=$|[\\/])/, homedir());
    const absolute = api.resolve(workingDir, expanded.replace(/\\/g, "/"));
    let canonical = cache.get(absolute);
    if (canonical === undefined) { canonical = fold(canonicalize(absolute)); cache.set(absolute, canonical); }
    return canonical;
  };
  const pattern = (value: string): string => {
    const normalized = fold(value), star = normalized.search(/[?*]/);
    if (star === -1) return path(normalized);
    if (star === 0) return normalized;
    const slash = normalized.lastIndexOf("/", star);
    const prefix = slash === -1 ? "." : normalized.slice(0, slash + 1);
    return `${path(prefix).replace(/\/$/, "")}/${normalized.slice(slash + 1)}`;
  };
  return { path, pattern };
}

/** One read operation: canonicalize each path once, without retaining decisions across calls. */
export function policyFileReadFilter(policy: EffectivePolicy, canonicalize = canonicalPolicyPath) {
  const canonical = new Map<string, string>();
  const real = (path: string): string => {
    const absolute = resolve(path);
    let value = canonical.get(absolute);
    if (value === undefined) {
      value = canonicalize(absolute);
      canonical.set(absolute, value);
    }
    return value;
  };
  const key = (path: string) => process.platform === "win32" || process.platform === "darwin" ? real(path).toLowerCase() : real(path);
  const files = policyFilePaths(policy);
  const protectedKeys = new Set(files.map(key));
  const exclusions = (root: string) => [...new Set(files.flatMap(file => [relative(resolve(root), resolve(file)), relative(real(root), real(file))])
    .filter(path => !isAbsolute(path) && path !== ".." && !path.startsWith("../") && !path.startsWith("..\\")).map(path => path.replace(/\\/g, "/")))];
  return { files, exclusions, allows: (path: string) => !protectedKeys.has(key(path)) };
}
