import { AGENT_TOOL_CHILD_ENV } from "./command-env.js";

export function projectDecisionOriginRefusal(): string | undefined {
  return !Object.keys(process.env).some((name) => name.toUpperCase() === AGENT_TOOL_CHILD_ENV) ? undefined
    : "Project decisions must be made from the operator's own terminal, outside an agent tool process.";
}


export const GLOBAL_SKILL_MUTATIONS: ReadonlySet<string> = new Set([
  "install", "update", "restore", "uninstall", "enable", "disable", "tap", "curate", "project",
]);
