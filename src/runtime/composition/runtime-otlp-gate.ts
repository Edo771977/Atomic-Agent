import { hostOfUrl, isLoopbackHost } from "../../llm/offline-network.js";
import { egressRefusal, type SessionProviderPolicy } from "../session-provider-policy.js";

/**
 * Which sessions' trace events the OTLP exporter (ATO-496) may send:
 *
 * - never an incognito chat (ATO-586), nor a side call partitioned under
 *   one (`reflection:<id>`): it leaves nothing behind;
 * - to a collector off this machine, only a session whose effective
 *   policy (folder constraint and read taint, issue #33) allows the
 *   `http` egress class: spans carry prompts, answers and tool results.
 *   A loopback collector keeps them local.
 *
 * Read per event, so a read taint set mid-turn stops the rest of it.
 */
export function createOtlpSessionGate(deps: {
  tracesUrl: string;
  isIncognito: (sessionId: string) => boolean;
  policy: Pick<SessionProviderPolicy, "constraintsActive" | "effectivePolicyForSession">;
}): (sessionId: string) => boolean {
  const host = hostOfUrl(deps.tracesUrl);
  const remote = host === null || !isLoopbackHost(host);
  return (sessionId) => {
    const ids = [sessionId];
    for (let id = sessionId; id.indexOf(":") > 0 && ids.length < 5; ) {
      id = id.slice(id.indexOf(":") + 1);
      ids.push(id);
    }
    if (ids.some((id) => deps.isIncognito(id))) return false;
    if (!remote) return true;
    return egressRefusal(deps.policy, sessionId, "http") === null;
  };
}
