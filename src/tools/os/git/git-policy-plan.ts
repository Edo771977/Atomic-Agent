import { join, relative, isAbsolute } from "node:path";
import { activePolicy } from "../../../policy/policy-active.js";
import { policyMayIntersectTree } from "../../../policy/policy-paths.js";
import { runGit, type GitRunOptions } from "./git-runner.js";

export function needsGitPolicyPlan(root: string): boolean {
  const policy = activePolicy();
  return policy.rules.some(rule => rule.action === "edit" && rule.effect !== "allow") || policyMayIntersectTree(policy, root);
}

export async function gitPlanPaths(probe: Omit<GitRunOptions, "args">, root: string, args: string[]): Promise<string[]> {
  const result = await runGit({ ...probe, args });
  if (result.exitCode !== 0 || result.timedOut || result.truncated) throw new Error("Cannot inspect complete Git mutation plan for organization policy");
  return result.stdout.split("\0").filter(Boolean).map(file => {
    const target = join(root, file), offset = relative(root, target);
    if (isAbsolute(file) || isAbsolute(offset) || offset === ".." || offset.startsWith("../") || offset.startsWith("..\\")) throw new Error("Indeterminate Git policy path");
    return target;
  });
}

export async function gitIndexPolicyPaths(probe: Omit<GitRunOptions, "args">, root: string, mode: "add" | "unstage" | "commit", paths: readonly string[], all: boolean): Promise<string[] | undefined> {
  if (!needsGitPolicyPlan(root)) return undefined;
  const plan: string[] = [];
  if (mode === "commit" || mode === "unstage") plan.push(...await gitPlanPaths(probe, root, ["diff", "--cached", "--name-only", "--no-renames", "-z", "--", ...(mode === "unstage" && !all ? paths : [])]));
  if (mode === "add" || mode === "commit" && (all || paths.length > 0)) {
    const scope = all ? [] : [...paths];
    plan.push(...await gitPlanPaths(probe, root, ["diff", "--name-only", "--no-renames", "-z", "--", ...scope]));
    plan.push(...await gitPlanPaths(probe, root, ["ls-files", "--full-name", "--others", "--exclude-standard", "-z", "--", ...scope]));
  }
  return [...new Set(plan)];
}
