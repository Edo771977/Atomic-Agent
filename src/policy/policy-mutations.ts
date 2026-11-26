import { statSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { describePolicyRule, evaluatePolicy, type EffectivePolicy } from "./policy-evaluator.js";
import { policyCallRefusal } from "./policy-enforce.js";
import { globMayMatchDescendant } from "./policy-glob.js";
import { createEditPathNormalizer, policyFilePaths } from "./policy-paths.js";

/** Actual mutation plans, independent of the caller's tool name or approval category. */
export function checkPolicyMutation(policy: EffectivePolicy, tool: string, paths: readonly string[], workingDir: string, directoryPaths: readonly string[] = [], moves: readonly { from: string; to: string }[] = []) {
  if (paths.length === 0) return { refusal: null, ask: false };
  if (!policy.rules.some(rule => rule.action === "edit" && rule.effect !== "allow") && policyFilePaths(policy).length === 0) return { refusal: null, ask: false };
  const normalize = createEditPathNormalizer(workingDir);
  const forms = (path: string) => [normalize.path(path)];
  const normalizedPolicy = { ...policy, rules: policy.rules.map(rule => rule.action === "edit" ? { ...rule, resource: normalize.pattern(rule.resource) } : rule) };
  const resources = [...new Set(paths.flatMap(forms))];
  const refusal = policyCallRefusal(normalizedPolicy, "os.fs.trash", { paths: resources }, workingDir, normalize)?.replace("os.fs.trash", tool) ?? null;
  if (refusal !== null) return { refusal, ask: false };
  let ask = evaluatePolicy(normalizedPolicy, "edit", resources)?.effect === "ask";
  if (!normalizedPolicy.rules.some(rule => rule.action === "edit" && rule.effect !== "allow")) return { refusal: null, ask };
  const explicitDirectories = new Set(directoryPaths.map(path => resolve(workingDir, path)));
  const trees = new Map<string, string[] | null>();
  let remaining = 4096;
  const descendants = (root: string): string[] | null => {
    if (trees.has(root)) return trees.get(root)!;
    const entries: string[] = [];
    const pending = [{ directory: root, relative: "", depth: 0 }];
    try {
      while (pending.length > 0) {
        const next = pending.pop()!;
        if (next.depth >= 64) throw new Error("depth limit");
        for (const entry of readdirSync(next.directory, { withFileTypes: true })) {
          if (--remaining < 0) throw new Error("entry limit");
          const path = join(next.relative, entry.name); entries.push(path);
          if (entry.isDirectory()) pending.push({ directory: join(root, path), relative: path, depth: next.depth + 1 });
        }
      }
      trees.set(root, entries); return entries;
    } catch { trees.set(root, null); return null; }
  };
  for (const path of paths) {
    let directory = explicitDirectories.has(resolve(workingDir, path));
    if (!directory) { try { directory = statSync(resolve(workingDir, path)).isDirectory(); } catch { /* new file */ } }
    if (!directory) continue;
    if (tool === "os.fs.move" || tool === "os.fs.trash") {
      const absolute = resolve(workingDir, path);
      const source = moves.find(move => resolve(workingDir, move.to) === absolute)?.from ?? path;
      const entries = descendants(resolve(workingDir, source));
      if (entries !== null) {
        const actual = entries.map(entry => normalize.path(join(absolute, entry)));
        const protectedRefusal = policyCallRefusal(policy, "os.fs.trash", { paths: actual }, workingDir, normalize);
        if (protectedRefusal !== null) return { refusal: protectedRefusal.replace("os.fs.trash", tool), ask: false };
        const verdict = evaluatePolicy(normalizedPolicy, "edit", actual);
        if (verdict?.effect === "deny") return { refusal: `${tool} was not run: blocked by organization policy (${describePolicyRule(verdict.rule)}) for a descendant.`, ask: false };
        ask ||= verdict?.effect === "ask";
        continue;
      }
      // Unreadable/oversized trees retain the conservative intersection below.
    }
    for (const rule of normalizedPolicy.rules) {
      if (rule.action !== "edit" || rule.effect === "allow") continue;
      if (!forms(path).some(dir => globMayMatchDescendant(rule.resource, dir) !== false)) continue;
      if (rule.effect === "deny") return { refusal: `${tool} was not run: blocked by organization policy (${describePolicyRule(rule)}) for possible descendants.`, ask: false };
      ask = true;
    }
  }
  return { refusal: null, ask };
}
