import {
  ensureUserConfigFileSync,
  getConfig,
  parseUserConfigFile,
  resetConfigCache,
  writeUserConfigFileSync,
} from "../../config/index.js";
import {
  isPrivacyShieldEnabled,
  privacyShieldTotals,
  privacyShieldSessionStats,
  setPrivacyShieldEnabled,
} from "../../privacy/index.js";
import { AGENT_TOOL_CHILD_ENV } from "../../sandbox/command-env.js";
import type { PrivacyShieldControl, PrivacyShieldStats } from "../runtime-contract.js";

export interface PrivacyShieldDeps {
  /** Write `privacy.shield.enabled` to the user config file. */
  persist?: (enabled: boolean) => void;
}

/**
 * `runtime.privacyShield` (ATO-1082): the live switch the TUI Privacy
 * tab, `/api/privacy-shield` and the desktop's Settings › Privacy row
 * drive. `setEnabled` persists the default that new turns snapshot.
 * Active turns keep their original setting.
 */
export function createPrivacyShieldControl(deps: PrivacyShieldDeps = {}): PrivacyShieldControl {
  const persist = deps.persist ?? persistPrivacyShield;
  return {
    isEnabled: () => isPrivacyShieldEnabled(),
    async setEnabled(enabled: boolean): Promise<void> {
      if (process.env[AGENT_TOOL_CHILD_ENV] !== undefined) {
        throw new Error("privacy shield can only be changed by the operator");
      }
      persist(enabled);
      setPrivacyShieldEnabled(enabled);
    },
    stats(sessionId?: string): PrivacyShieldStats {
      const totals = privacyShieldTotals();
      if (!sessionId) return totals;
      return { ...totals, session: privacyShieldSessionStats(sessionId) };
    },
  };
}

/** read → merge → validate → write → reset, like the other persist helpers. */
export function persistPrivacyShield(enabled: boolean): void {
  const path = getConfig().paths.userConfigFile;
  const prev = ensureUserConfigFileSync(path);
  const draft = {
    ...prev,
    privacy: { ...prev.privacy, shield: { ...prev.privacy?.shield, enabled } },
  };
  writeUserConfigFileSync(path, parseUserConfigFile(draft));
  resetConfigCache();
}
