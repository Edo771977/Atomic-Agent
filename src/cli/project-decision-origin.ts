import { AGENT_TOOL_CHILD_ENV } from "../sandbox/command-env.js";

export function projectDecisionOriginRefusal(): string | undefined {
  return process.env[AGENT_TOOL_CHILD_ENV] === undefined ? undefined
    : "Project decisions must be made from the operator's own terminal, outside an agent tool process.";
}
