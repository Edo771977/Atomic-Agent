import { activePolicy } from "./policy-active.js";
import { policyCallRefusal } from "./policy-enforce.js";

/** A destination check, independent of prompts, transport and domain allowlists. */
export function assertPolicyWebUrl(url: string, workingDir?: string): void {
  const refused = policyCallRefusal(activePolicy(), "os.web.fetch", { url }, workingDir);
  if (refused !== null) throw new Error(refused);
}
