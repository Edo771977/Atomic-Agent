/**
 * One {@link PrivacyVault} per session (ATO-599), so placeholders stay
 * stable across the turns of a chat and never mean another chat's data.
 * In memory only, like the vaults themselves. The counters read here
 * feed the "masked N" line of the Privacy tab and Settings › Privacy.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { knownSecretsFromEnv, type KnownSecret } from "../error-reporting/secret-detector.js";
import { PrivacyArchiveLimitError, PrivacyVault } from "./privacy-vault.js";

const MAX_SESSION_VAULTS = 128;
const MAX_CLOSED_SESSIONS = 1024;
const vaults = new Map<string, PrivacyVault>();
const closedSessions = new Set<string>();
const activeTurns = new Map<string, number>();

function markClosed(id: string): void {
  closedSessions.delete(id);
  closedSessions.add(id);
  if (closedSessions.size > MAX_CLOSED_SESSIONS) {
    const oldest = closedSessions.values().next().value;
    if (oldest !== undefined) closedSessions.delete(oldest);
  }
}

function trimVaults(): void {
  for (const id of vaults.keys()) {
    if (vaults.size <= MAX_SESSION_VAULTS) break;
    if (!activeTurns.has(id)) vaults.delete(id);
  }
}

export function pinPrivacyVault(sessionId: string): () => void {
  const id = vaultKey(sessionId);
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
const vaultKey = (id: string): string => aliases.get(id) ?? id;
const turnShield = new AsyncLocalStorage<{ id: string; enabled: boolean; shared: boolean }>();
const workerReferences = new AsyncLocalStorage<Map<PrivacyVault, Set<string>> | null>();

function newVault(): PrivacyVault {
  return new PrivacyVault(() => knownSecrets(), {
    record(vault, references) {
      const scope = workerReferences.getStore();
      if (!scope) return;
      const seen = scope.get(vault) ?? new Set<string>();
      for (const reference of references) seen.add(reference);
      scope.set(vault, seen);
    },
    canRestore(vault, reference) {
      const scope = workerReferences.getStore();
      return !scope || scope.get(vault)?.has(reference) === true;
    },
  });
}

/** Workers inherit their parent turn's setting, including after a live toggle. */
export function withPrivacyShieldTurn<T>(sessionId: string, run: () => T): T {
  const owner = aliases.get(sessionId);
  const parent = turnShield.getStore();
  const turn = owner !== undefined && parent?.id === owner
    ? parent
    : { id: owner ?? sessionId, enabled: shieldEnabled, shared: owner !== undefined };
  return workerReferences.run(owner === undefined ? null : new Map(), () => turnShield.run(turn, run));
}

export function isPrivacyShieldEnabledForRequest(sessionId?: string): boolean {
  const turn = turnShield.getStore();
  return turn && (!sessionId || turn.id === vaultKey(sessionId)) ? turn.enabled : shieldEnabled;
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
  if (!sessionId || closedSessions.has(sessionId)) return newVault();
  const key = vaultKey(sessionId);
  const vault = vaults.get(key) ?? newVault();
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
  const turn = turnShield.getStore();
  if (turn?.shared && sessionId && turn.id === vaultKey(sessionId)) throw new PrivacyArchiveLimitError();
  const fresh = newVault();
  mask(fresh);
  if (sessionId) {
    const key = vaultKey(sessionId);
    if (vaults.get(key) === previous) vaults.set(key, fresh);
  }
  return fresh;
}

/**
 * Make `sessionId` (a Fusion worker) use `parentSessionId`'s vault. A
 * parent that is itself linked resolves to its own parent.
 */
export function linkPrivacyVault(sessionId: string, parentSessionId: string): void {
  if (sessionId === parentSessionId) return;
  const parent = vaultKey(parentSessionId);
  if (closedSessions.has(parent)) {
    forgetPrivacyVault(sessionId);
    return;
  }
  if (closedSessions.has(sessionId)) return;
  aliases.set(sessionId, parent);
  const turn = turnShield.getStore();
  if (turn?.id === parent) turn.shared = true;
}

/** A worker can run another turn under the same ID. */
export function unlinkPrivacyVault(sessionId: string): void {
  aliases.delete(sessionId);
}

/** Release the archive of a finished chat that can still be continued. */
export function releasePrivacyVault(sessionId: string): void {
  vaults.delete(sessionId);
}

/** Drop a session's vault (the session was deleted), and its worker links. */
export function forgetPrivacyVault(sessionId: string): void {
  markClosed(sessionId);
  vaults.delete(sessionId);
  aliases.delete(sessionId);
  for (const [worker, parent] of aliases) {
    if (parent === sessionId) {
      markClosed(worker);
      aliases.delete(worker);
    }
  }
}

/** Protect evidence from restored provider values without changing the archive. */
export function redactPrivacyEvidence<T>(sessionId: string, value: T, options?: { always?: boolean }): T {
  const vault = vaults.get(vaultKey(sessionId));
  if (vault) return vault.redactEvidence(value);
  return options?.always || isPrivacyShieldEnabledForRequest(sessionId)
    ? new PrivacyVault(() => knownSecrets()).redactEvidence(value)
    : value;
}

/** A status read must not create a vault or change eviction order. */
export function privacyShieldSessionStats(id: string): { masked: number; lastRequest: number } {
  const stats = vaults.get(vaultKey(id))?.stats();
  return { masked: stats?.distinct ?? 0, lastRequest: stats?.lastRequest ?? 0 };
}

export interface PrivacyShieldTotals {
  /** Distinct values masked, summed across retained session archives. */
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
  closedSessions.clear();
  activeTurns.clear();
  aliases.clear();
  knownSecrets = () => knownSecretsFromEnv();
  shieldEnabled = false;
}
