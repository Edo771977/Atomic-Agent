import { statSync } from "node:fs";
import { resolve } from "node:path";
import { describePolicyRule, evaluatePolicy, type EffectivePolicy } from "./policy-evaluator.js";
import { policyCallRefusal } from "./policy-enforce.js";
import { globMayMatchDescendant } from "./policy-glob.js";
import { createEditPathNormalizer } from "./policy-paths.js";

/** Actual mutation plans, independent of the caller's tool name or approval category. */
export function checkPolicyMutation(policy: EffectivePolicy, tool: string, paths: readonly string[], workingDir: string, directoryPaths: readonly string[] = []) {
  if (paths.length === 0) return { refusal: null, ask: false };
  const normalize = createEditPathNormalizer(workingDir);
  const forms = (path: string) => [normalize.path(path)];
  const normalizedPolicy = { ...policy, rules: policy.rules.map(rule => rule.action === "edit" ? { ...rule, resource: normalize.pattern(rule.resource) } : rule) };
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
