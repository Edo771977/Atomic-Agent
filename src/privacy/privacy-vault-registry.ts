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
/**
 * Fusion worker session id -> its parent session id (ATO-1083). A cloud
 * worker masks with its parent chat's vault, so the planner and every
 * cloud worker of a chat use the same placeholders, and "masked N"
 * counts a value once per chat however many workers saw it.
 */
const aliases = new Map<string, string>();
/** Worker ids are ephemeral; the oldest links go past this many. */
const MAX_ALIASES = 1024;
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
  const key = aliases.get(sessionId) ?? sessionId;
  const vault = vaults.get(key) ?? new PrivacyVault(() => knownSecrets());
  vaults.delete(key);
  vaults.set(key, vault);
  trimVaults();
  return vault;
}

/** Rebuild without invalidating the references used by an in-flight response. */
export function rebuildPrivacyVault(
  sessionId: string | undefined,
  previous: PrivacyVault,
  mask: (fresh: PrivacyVault) => void,
): PrivacyVault {
  const fresh = new PrivacyVault(() => knownSecrets());
  mask(fresh);
  if (sessionId && vaults.get(sessionId) === previous) vaults.set(sessionId, fresh);
  return fresh;
}

/** Drop a session's vault (the session was deleted). */
/**
 * Make `sessionId` (a Fusion worker) use `parentSessionId`'s vault. A
 * parent that is itself linked resolves to its own parent.
 */
export function linkPrivacyVault(sessionId: string, parentSessionId: string): void {
  if (sessionId === parentSessionId) return;
  aliases.delete(sessionId);
  aliases.set(sessionId, aliases.get(parentSessionId) ?? parentSessionId);
  while (aliases.size > MAX_ALIASES) {
    const oldest = aliases.keys().next().value;
    if (oldest === undefined) break;
    aliases.delete(oldest);
  }
}

/** Drop a session's vault (the session was deleted), and its worker links. */
export function forgetPrivacyVault(sessionId: string): void {
  vaults.delete(sessionId);
  aliases.delete(sessionId);
  for (const [worker, parent] of aliases) {
    if (parent === sessionId) aliases.delete(worker);
  }
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
  aliases.clear();
  knownSecrets = () => knownSecretsFromEnv();
  shieldEnabled = false;
}
