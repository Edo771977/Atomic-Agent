import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { withAsyncFileLock, withFileLock } from "../../session/project-lock.js";
import { currentTurnOwnerProbe, isTurnOwnerGone, parseTurnOwner, serializeTurnOwner, turnOwnerFor } from "../../session/turn-owner.js";
import { join, resolve } from "node:path";

/** The canonical session folder owns its drafts, approved files and undo history. */
export function learnedSkillScope(stateDir: string, workingDir: string) {
  const folder = realpathSync.native(workingDir);
  const key = createHash("sha256").update(folder).digest("hex");
  const root = canonicalStateDir(stateDir);
  const scope = join(root, "learned-projects", key);
  return { folder, stateDir: scope, skillsDir: join(scope, "skills") };
}

function canonicalStateDir(stateDir: string): string {
  try { return realpathSync(stateDir); }
  catch { return resolve(stateDir); }
}

/** Per-turn leases cover even the first turn, before a session row exists. */
export async function withLearnedTurn<T>(stateDir: string, folder: string, run: () => Promise<T>): Promise<T> {
  const scope = learnedSkillScope(stateDir, folder);
  const active = join(scope.stateDir, "running");
  await mkdir(active, { recursive: true, mode: 0o700 });
  const lease = join(active, randomUUID());
  const probe = currentTurnOwnerProbe();
  const temp = join(active, "." + randomUUID());
  await writeFile(temp, serializeTurnOwner(turnOwnerFor(probe, Date.now())), { mode: 0o600, flag: "wx" });
  await rename(temp, lease);
  try {
    // A decision that already passed its final lease check gets to finish first.
    while (!withFileLock(activationLock(scope.stateDir), () => undefined, lockOptions).ok) {
      await delay(25);
    }
    return await run();
  } finally {
    await rm(lease, { force: true });
  }
}

const lockOptions = { waitMs: 0, staleMs: 120_000 };

function activationLock(scopeDir: string): string {
  return join(scopeDir, ".activate-lock");
}

export async function withLearnedDecision<T>(scopeDir: string, decide: () => Promise<T>): Promise<T> {
  await mkdir(scopeDir, { recursive: true, mode: 0o700 });
  if (realpathSync(scopeDir) !== scopeDir) throw new Error("The learned skill storage path is not canonical.");
  const result = await withAsyncFileLock(activationLock(scopeDir), decide, lockOptions);
  if (!result.ok) throw new Error("Another learned skill decision is in progress. Try again.");
  return result.value;
}

export function learnedTurnRunning(scopeDir: string): boolean {
  const active = join(scopeDir, "running");
  let leases: string[];
  try { leases = readdirSync(active); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const probe = currentTurnOwnerProbe();
  for (const entry of leases) {
    if (!/^[0-9a-f-]{36}$/.test(entry)) continue;
    let raw: string;
    const lease = join(active, entry);
    try { raw = readFileSync(lease, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const owner = parseTurnOwner(raw);
    if (!owner || (owner.pid === probe.pid
      ? owner.processStart === undefined || probe.processStartOf(probe.pid) === owner.processStart
      : !isTurnOwnerGone(raw, probe))) return true;
    rmSync(lease, { force: true });
  }
  return false;
}
