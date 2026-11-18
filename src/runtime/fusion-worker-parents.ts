import { readFusionWorkerMeta } from "../session/fusion-worker-session.js";

/** How many orchestrator levels are followed (the read taint's hop limit too). */
const MAX_HOPS = 4;

/**
 * The orchestrators of Fusion worker `sessionId`, parent first, read from
 * the live sessions' worker metadata (`metadataOf`: a running turn's
 * session, `undefined` when none). Empty for a session that is no worker.
 */
export function fusionWorkerParents(
  sessionId: string,
  metadataOf: (sessionId: string) => Record<string, unknown> | undefined,
): string[] {
  const parents: string[] = [];
  let current = sessionId;
  for (let hops = 0; hops < MAX_HOPS; hops += 1) {
    const parent = readFusionWorkerMeta(metadataOf(current))?.parentSessionId;
    if (parent === undefined || parent === current || parents.includes(parent)) break;
    parents.push(parent);
    current = parent;
  }
  return parents;
}
