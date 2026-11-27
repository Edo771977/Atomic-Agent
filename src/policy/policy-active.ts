import { resolveStateDir } from "../config/load-config.js";
import type { EffectivePolicy } from "./policy-evaluator.js";
import { loadLocalPolicy } from "./policy-loader.js";
import { POLICY_FILE_PINS_ENV } from "../config/org-policy-paths.js";

let active: EffectivePolicy | null = null;

/**
 * Set by the runtime at boot, after `loadPolicy` fetched the URL. The same
 * install / read pair as `installToolHooks`: the skill installer and the
 * dispatcher read it per call instead of having it threaded through.
 * `null` forgets it, so the next read loads the local copy again.
 */
export function installPolicy(policy: EffectivePolicy | null): void {
  active = policy;
  rememberPins(policy);
}

/** Child launch metadata carries identities, never rule bodies or delivery URLs. */
function rememberPins(policy: EffectivePolicy | null): void {
  if (policy === null) { delete process.env[POLICY_FILE_PINS_ENV]; return; }
  let pins = policy.filePins ?? [];
  if (process.env.ATOMIC_AGENT_TOOL_CHILD !== undefined && process.env[POLICY_FILE_PINS_ENV] !== undefined) {
    try {
      const inherited: unknown = JSON.parse(process.env[POLICY_FILE_PINS_ENV]!);
      if (!Array.isArray(inherited)) return; // Retain invalid metadata for the loader's refusal.
      pins = [...inherited, ...pins];
    } catch { return; }
  }
  const unique = [...new Map(pins.map(pin => [pin.path, pin])).values()];
  if (unique.length) process.env[POLICY_FILE_PINS_ENV] = JSON.stringify(unique);
  else delete process.env[POLICY_FILE_PINS_ENV];
}

/**
 * The installed policy, or (in a short-lived command that never booted a
 * runtime) the local files plus the cached URL copy, read once.
 * A broken local policy refuses startup or the call; it is never empty policy.
 */
export function activePolicy(): EffectivePolicy {
  if (active !== null) return active;
  active = loadLocalPolicy({ stateDir: resolveStateDir() });
  rememberPins(active);
  return active;
}
