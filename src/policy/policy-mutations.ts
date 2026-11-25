import { statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { describePolicyRule, evaluatePolicy, type EffectivePolicy } from "./policy-evaluator.js";
import { policyCallRefusal } from "./policy-enforce.js";
import { globMayMatchDescendant } from "./policy-glob.js";
import { canonicalPolicyPath } from "./policy-paths.js";

/** Actual mutation plans, independent of the caller's tool name or approval category. */
export function checkPolicyMutation(policy: EffectivePolicy, tool: string, paths: readonly string[], workingDir: string, directoryPaths: readonly string[] = []) {
  if (paths.length === 0) return { refusal: null, ask: false };
  const normalize = (value: string) => {
    const path = value.replace(/\\/g, "/");
    return process.platform === "win32" || process.platform === "darwin" ? path.toLowerCase() : path;
  };
  const forms = (path: string) => {
    const absolute = resolve(workingDir, path), canonical = canonicalPolicyPath(absolute);
    const local = relative(workingDir, absolute);
    return [...new Set([path, absolute, canonical, ...(!isAbsolute(local) && local !== ".." && !local.startsWith("..\\") && !local.startsWith("../") ? [local] : [])].map(normalize))];
  };
  const normalizedPolicy = { ...policy, rules: policy.rules.map(rule => ({ ...rule, resource: normalize(rule.resource) })) };
  const resources = [...new Set(paths.flatMap(forms))];
  const refusal = policyCallRefusal(normalizedPolicy, "os.fs.trash", { paths: resources }, workingDir)?.replace("os.fs.trash", tool) ?? null;
  if (refusal !== null) return { refusal, ask: false };
  let ask = evaluatePolicy(normalizedPolicy, "edit", resources)?.effect === "ask";
  const explicitDirectories = new Set(directoryPaths.map(path => resolve(workingDir, path)));
  for (const path of paths) {
    let directory = explicitDirectories.has(resolve(workingDir, path));
    if (!directory) { try { directory = statSync(resolve(workingDir, path)).isDirectory(); } catch { /* new file */ } }
    if (!directory) continue;
    for (const rule of normalizedPolicy.rules) {
      if (rule.action !== "edit" || rule.effect === "allow") continue;
      if (!forms(path).some(dir => globMayMatchDescendant(rule.resource, dir) !== false)) continue;
      if (rule.effect === "deny") return { refusal: `${tool} was not run: blocked by organization policy (${describePolicyRule(rule)}) for possible descendants.`, ask: false };
      ask = true;
    }
  }
  return { refusal: null, ask };
}
