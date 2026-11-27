import { activePolicy } from "./policy-active.js";
import { policyCallRefusal, policyCallAsks } from "./policy-enforce.js";
import { evaluatePolicy } from "./policy-evaluator.js";
import { requireApproval, type DangerousToolOptions } from "../approval/dangerous-tool.js";
import { maskUrlSecrets } from "../tools/os/web/http-request-preview.js";

/** A destination check, independent of prompts, transport and domain allowlists. */
export function assertPolicyWebUrl(url: string, workingDir?: string): void {
  const refused = policyCallRefusal(activePolicy(), "os.web.fetch", { url }, workingDir);
  if (refused !== null) throw new Error(refused);
}

export async function requirePolicyWebUrl(options: DangerousToolOptions, tool: string, url: string, ctx: { sessionId: string; signal: AbortSignal; workingDir?: string }): Promise<void> {
  const unknown = url === "" ? evaluatePolicy(activePolicy(), "webfetch", [], { unreadable: true }) : null;
  if (unknown?.effect === "deny") throw new Error(`${tool}: organization policy refuses an unreadable network destination`);
  assertPolicyWebUrl(url, ctx.workingDir);
  if (unknown?.effect !== "ask" && !policyCallAsks(activePolicy(), "os.web.fetch", { url })) return;
  await requireApproval({ ...options, approvalRequired: true }, { sessionId: ctx.sessionId, tool, category: "http", reason: "Organization policy requires a decision for this network destination", affectedResources: [maskUrlSecrets(url)] }, ctx.signal, true);
}
