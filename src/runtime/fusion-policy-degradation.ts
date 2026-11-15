import type { ProviderPolicy } from "../llm/provider-policy.js";
import type { ResolvedRunMode } from "../llm/run-mode/index.js";

/** The fan-out tool a degraded fusion turn must not offer or run. */
export const FUSION_DELEGATE_TOOL = "fusion.delegate";

/**
 * What a folder's provider policy leaves of the Fusion run mode for one
 * turn (issue #33):
 *
 * - `none`: not Fusion, no policy, or both legs allowed — Fusion as is.
 * - `orchestrator-solo`: the orchestrator is allowed, the worker leg is
 *   not — the orchestrator works alone, without `fusion.delegate`.
 * - `worker-solo`: the orchestrator is not allowed, the worker leg is —
 *   the turn runs pinned to the worker leg as a single model, without
 *   `fusion.delegate` (typically the local model).
 * - `none-allowed`: neither leg is allowed — no fan-out, no pin; the
 *   fallback chain then starts on an allowed link if one exists and
 *   otherwise refuses with the terminal message.
 */
export type FusionPolicyDegradation =
  | { kind: "none" }
  | { kind: "orchestrator-solo" }
  | { kind: "worker-solo"; providerId: string }
  | { kind: "none-allowed" };

export function fusionPolicyDegradation(
  runMode: Pick<ResolvedRunMode, "effective" | "orchestratorProviderId" | "workerProviderId" | "primaryProviderId">,
  policy: ProviderPolicy | undefined,
): FusionPolicyDegradation {
  if (runMode.effective !== "fusion" || policy === undefined) return { kind: "none" };
  const orchestrator = runMode.orchestratorProviderId ?? runMode.primaryProviderId;
  const worker = runMode.workerProviderId;
  const orchestratorOk = policy.allows(orchestrator);
  const workerOk = worker !== null && policy.allows(worker);
  if (orchestratorOk && workerOk) return { kind: "none" };
  if (orchestratorOk) return { kind: "orchestrator-solo" };
  if (workerOk) return { kind: "worker-solo", providerId: worker };
  return { kind: "none-allowed" };
}

/** `filter` minus `fusion.delegate`. */
export function withoutFusionDelegate(
  filter: ((name: string) => boolean) | undefined,
): (name: string) => boolean {
  return (name) => name !== FUSION_DELEGATE_TOOL && (filter?.(name) ?? true);
}
