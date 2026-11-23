/**
 * One {@link PrivacyVault} per session (ATO-599), so placeholders stay
 * stable across the turns of a chat and never mean another chat's data.
 * In memory only, like the vaults themselves. The counters read here
 * feed the "masked N" line of the Privacy tab and Settings › Privacy.
 */

import { knownSecretsFromEnv, type KnownSecret } from "../error-reporting/secret-detector.js";
import { PrivacyVault } from "./privacy-vault.js";

const MAX_SESSION_VAULTS = 128;
const vaults = new Map<string, PrivacyVault>();
const activeTurns = new Map<string, number>();

function trimVaults(): void {
  for (const id of vaults.keys()) {
    if (vaults.size <= MAX_SESSION_VAULTS) break;
    if (!activeTurns.has(id)) vaults.delete(id);
  }
}

export function pinPrivacyVault(id: string): () => void {
  activeTurns.set(id, (activeTurns.get(id) ?? 0) + 1);
  return () => {
    const remaining = (activeTurns.get(id) ?? 1) - 1;
    if (remaining > 0) activeTurns.set(id, remaining);
    else activeTurns.delete(id);
    trimVaults();
  };
}
/** The agent's own keys (its `.env` is loaded into `process.env`). */
let knownSecrets: () => readonly KnownSecret[] = () => knownSecretsFromEnv();
let shieldEnabled = false;

/**
 * Bootstrap sets the process default from config at startup. Provider
 * overrides are captured separately when their adapters are built.
 */
export function isPrivacyShieldEnabled(): boolean {
  return shieldEnabled;
}

export function setPrivacyShieldEnabled(enabled: boolean): void {
  shieldEnabled = enabled;
}

/** Exact values every new vault treats as secret (the agent's own keys). */
export function setPrivacyKnownSecrets(source: () => readonly KnownSecret[]): void {
  knownSecrets = source;
}

export function privacyVaultFor(sessionId: string | null | undefined): PrivacyVault {
  // Auxiliary calls have no session lifetime and must not share substitutions.
  if (!sessionId) return new PrivacyVault(() => knownSecrets());
  const key = sessionId;
  const vault = vaults.get(key) ?? new PrivacyVault(() => knownSecrets());
  vaults.delete(key);
  vaults.set(key, vault);
  trimVaults();
  return vault;
}

/** Drop a session's vault (the session was deleted). */
export function forgetPrivacyVault(sessionId: string): void {
  vaults.delete(sessionId);
}

export interface PrivacyShieldTotals {
  /** Distinct values masked, summed over every session of this process. */
  masked: number;
  /** Sessions that had anything masked. */
  sessions: number;
}

export function privacyShieldTotals(): PrivacyShieldTotals {
  let masked = 0;
  let sessions = 0;
  for (const vault of vaults.values()) {
    const { distinct } = vault.stats();
    masked += distinct;
    if (distinct > 0) sessions += 1;
  }
  return { masked, sessions };
}

/** Tests only. */
export function resetPrivacyVaults(): void {
  vaults.clear();
  activeTurns.clear();
  knownSecrets = () => knownSecretsFromEnv();
  shieldEnabled = false;
}
