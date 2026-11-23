import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Database } from "../native/load-better-sqlite3.js";
import { MemoryStore } from "../memory/memory-store.js";
import { ProfileStore } from "../memory/profile-store.js";
import { defaultBackupDir, runMemoryBackup } from "./memory-backup.js";

import { createMemoryBackup, restoreMemoryBackup } from "../memory/memory-backup.js";

let dir: string;
let dbFile: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memory-backup-"));
  dbFile = join(dir, "memory.sqlite");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function quiet() {
  const lines: string[] = [];
  return { lines, out: (t: string) => void lines.push(t), err: (t: string) => void lines.push(t) };
}

describe("atomic-agent memory backup (ATO-46)", () => {
  it("copies notes and facts while the stores are open, and says how to restore", async () => {
    const notes = new MemoryStore({ dbFile, maxEntries: 100 });
    const profile = new ProfileStore({ dbFile });
    notes.store({ content: "The person ships on Fridays", tags: [], source: "user" });
    profile.set("city", "Lisbon");
    const out = join(dir, "bk");
    const io = quiet();
    expect(await runMemoryBackup(out, { memoryDbFile: dbFile, stateDir: dir, ...io })).toBe(0);
    notes.close();
    profile.close();

    const copy = new Database(join(out, "memory.sqlite"), { readonly: true });
    try {
      const tables = (copy.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
      expect(tables.length).toBeGreaterThan(0);
    } finally {
      copy.close();
    }
    const copyNotes = new MemoryStore({ dbFile: join(out, "memory.sqlite"), maxEntries: 100 });
    expect(copyNotes.hasContent("The person ships on Fridays")).toBe(true);
    copyNotes.close();
    const note = readFileSync(join(out, "RESTORE.txt"), "utf8");
    expect(note).toContain("atomic-agent memory restore --from .");
    // The import restores notes and facts only (ATOMIC_DESKTOP_NOT_IMPORTED); the note must not promise more.
    expect(note).toContain("does not bring back lessons, procedures, votes or note links");
    expect(io.lines.join("")).toContain("memory restore --from");
  });

  it("publishes private files and merges twice without duplicates", async () => {
    const source = new MemoryStore({ dbFile, maxEntries: 10 });
    const profile = new ProfileStore({ dbFile });
    source.store({ content: "A stable note about oranges" });
    profile.set("city", "Milan");
    const out = join(dir, "bk");
    expect(await runMemoryBackup(out, { memoryDbFile: dbFile, stateDir: dir, ...quiet() })).toBe(0);
    source.close();
    profile.close();
    if (process.platform !== "win32") {
      for (const file of ["memory.sqlite", "RESTORE.txt"]) {
        expect(statSync(join(out, file)).mode & 0o777).toBe(0o600);
      }
    }
    const target = { memoryDbFile: join(dir, "live", "memory.sqlite") };
    expect(restoreMemoryBackup(target, out)).toEqual({ notes: 1, facts: 1 });
    expect(restoreMemoryBackup(target, out)).toEqual({ notes: 0, facts: 0 });
    const restored = new MemoryStore({ dbFile: target.memoryDbFile, maxEntries: 10 });
    try {
      expect(restored.recall("oranges")).toHaveLength(1);
    } finally {
      restored.close();
    }
  });

  it.skipIf(process.platform !== "win32")("publishes Windows files with only the current user's ACL", async () => {
    new MemoryStore({ dbFile, maxEntries: 10 }).close();
    const out = join(dir, "bk");
    await createMemoryBackup({ memoryDbFile: dbFile }, out);
    for (const file of ["memory.sqlite", "RESTORE.txt"]) {
      const result = execFileSync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        `$acl = Get-Acl -LiteralPath $env:ATAG_BACKUP_ACL_TEST_PATH
         $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
         $rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
         if (!$acl.AreAccessRulesProtected -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid) {
           exit 1
         }`,
      ], { env: { ...process.env, ATAG_BACKUP_ACL_TEST_PATH: join(out, file) } });
      expect(result.toString()).toBe("");
    }
  });

  it("rolls back a partial merge and permits a clean retry", async () => {
    const notes = new MemoryStore({ dbFile, maxEntries: 10 });
    notes.store({ content: "A note before the interruption" });
    const profile = new ProfileStore({ dbFile });
    profile.set("city", "Rome");
    const out = join(dir, "bk");
    await createMemoryBackup({ memoryDbFile: dbFile }, out);
    notes.close();
    profile.close();

    const target = { memoryDbFile: join(dir, "target.sqlite") };
    new MemoryStore({ dbFile: target.memoryDbFile, maxEntries: 10 }).close();
    const live = new Database(target.memoryDbFile);
    try {
      live.exec(`CREATE TRIGGER interrupt_restore BEFORE INSERT ON profile_facts
        BEGIN SELECT RAISE(ABORT, 'interrupted'); END`);
      expect(() => restoreMemoryBackup(target, out)).toThrow("interrupted");
      expect(live.prepare("SELECT count(*) FROM memories").pluck().get()).toBe(0);
      live.exec("DROP TRIGGER interrupt_restore");
      expect(restoreMemoryBackup(target, out)).toEqual({ notes: 1, facts: 1 });
      expect(restoreMemoryBackup(target, out)).toEqual({ notes: 0, facts: 0 });
    } finally {
      live.close();
    }
  });

  it("refuses a restore that would evict notes or unpinned facts", async () => {
    const notes = new MemoryStore({ dbFile, maxEntries: 60 });
    for (let i = 0; i < 50; i++) notes.store({ content: `backup note ${i}` });
    notes.close();
    const facts = new ProfileStore({ dbFile });
    facts.set("city", "Rome", { pinned: false });
    facts.close();
    const out = join(dir, "bk");
    await createMemoryBackup({ memoryDbFile: dbFile }, out);
    const target = { memoryDbFile: join(dir, "target.sqlite"), maxEntries: 20, profileMaxEntries: 1 };
    const liveNotes = new MemoryStore({ dbFile: target.memoryDbFile, maxEntries: 20 });
    const liveFacts = new ProfileStore({ dbFile: target.memoryDbFile });
    try {
      for (let i = 0; i < 20; i++) liveNotes.store({ content: `live note ${i}` });
      liveFacts.set("language", "Italian", { pinned: false });
      expect(() => restoreMemoryBackup(target, out)).toThrow(/50 notes.*1 profile facts.*50 notes.*1 profile facts/);
      expect(liveNotes.count()).toBe(20);
      expect(liveFacts.list().map((fact) => fact.key)).toEqual(["language"]);
    } finally {
      liveFacts.close();
      liveNotes.close();
    }
  });

  it("validates edited archives, reports reasons and resets untrusted provenance", async () => {
    const notes = new MemoryStore({ dbFile, maxEntries: 20 });
    for (const content of ["valid note", "oversize", "invisible", "malformed scope", "scoped overlap", "invalid unicode"]) notes.store({ content });
    notes.close();
    const facts = new ProfileStore({ dbFile });
    facts.set("name", "Ada", { nameGrounding: "grounded" });
    facts.set("city", "Rome");
    facts.set("language", "Italian");
    facts.close();
    const out = join(dir, "bk");
    await createMemoryBackup({ memoryDbFile: dbFile }, out);
    const edited = new Database(join(out, "memory.sqlite"));
    edited.prepare("UPDATE memories SET source = 'untrusted', tags = ? WHERE content = 'valid note'").run(JSON.stringify(["superseded", "topic"]));
    edited.prepare("UPDATE memories SET content = ? WHERE content = 'oversize'").run("x".repeat(30_000));
    edited.prepare("UPDATE memories SET content = ? WHERE content = 'invisible'").run("hidden\u202e marker");
    edited.exec("UPDATE memories SET constraint_scope = 'invalid' WHERE content = 'malformed scope'");
    edited.exec("UPDATE memories SET content = CAST(x'ff' AS TEXT) WHERE content = 'invalid unicode'");
    edited.exec("UPDATE profile_facts SET key = 'invalid key' WHERE key = 'city'");
    edited.prepare("UPDATE profile_facts SET value = ? WHERE key = 'language'").run("x".repeat(30_000));
    edited.close();

    const target = { memoryDbFile: join(dir, "target.sqlite") };
    const live = new MemoryStore({ dbFile: target.memoryDbFile, maxEntries: 20 });
    live.store({ content: "scoped overlap" });
    live.close();
    const db = new Database(target.memoryDbFile);
    db.prepare("UPDATE memories SET constraint_scope = ?").run(JSON.stringify({ key: "private", allowedProviders: [] }));
    const preview = restoreMemoryBackup({ ...target, preview: true }, out);
    expect(preview).toMatchObject({ notes: 1, facts: 1, rejected: 7, reasons: {
      "note content": 1, "invalid text": 2, "invalid scope": 1, "scope mismatch": 1,
      "profile key": 1, "profile value": 1,
    } });
    expect(db.prepare("SELECT count(*) FROM memories").pluck().get()).toBe(1);
    const restored = restoreMemoryBackup(target, out);
    expect(restored).toMatchObject({ notes: 1, facts: 1, rejected: 7 });
    expect(db.prepare("SELECT source, tags FROM memories WHERE content = 'valid note'").get()).toEqual({ source: "agent", tags: '["topic"]' });
    expect(db.prepare("SELECT name_grounding FROM profile_facts WHERE key = 'name'").pluck().get()).toBeNull();
    db.close();
  });

  it("rejects a mismatched schema before creating the target", async () => {
    new MemoryStore({ dbFile, maxEntries: 10 }).close();
    const out = join(dir, "bk");
    await createMemoryBackup({ memoryDbFile: dbFile }, out);
    const snapshot = new Database(join(out, "memory.sqlite"));
    snapshot.exec("UPDATE schema_meta SET value = '999' WHERE key = 'version'");
    snapshot.close();
    const target = { memoryDbFile: join(dir, "target.sqlite") };
    expect(() => restoreMemoryBackup(target, out)).toThrow(/unsupported memory schema/);
    expect(existsSync(target.memoryDbFile)).toBe(false);
  });

  it("ignores removed credentials in the backup journal", async () => {
    const profile = new ProfileStore({ dbFile });
    profile.set("city", "Rome");
    const live = new Database(dbFile);
    live.exec("UPDATE profile_facts SET key = 'pin', value = '4821'");
    profile.remove("pin");
    expect(live.prepare("SELECT count(*) FROM memory_change_log").pluck().get()).toBe(1);
    live.close();
    profile.close();
    const out = join(dir, "bk");
    await createMemoryBackup({ memoryDbFile: dbFile }, out);
    const copy = new Database(join(out, "memory.sqlite"), { readonly: true });
    expect(copy.prepare("SELECT count(*) FROM memory_change_log").pluck().get()).toBe(0);
    copy.close();
    expect(readFileSync(join(out, "memory.sqlite")).includes(Buffer.from("4821"))).toBe(false);
  });

  it("never publishes a backup containing a legacy credential", async () => {
    const profile = new ProfileStore({ dbFile });
    profile.set("city", "Rome");
    profile.close();
    const live = new Database(dbFile);
    live.exec("UPDATE profile_facts SET key = 'pin', value = '4821'");
    live.close();
    const out = join(dir, "bk");
    await expect(createMemoryBackup({ memoryDbFile: dbFile }, out)).rejects.toThrow(/profile_facts.*entry 1.*contains a credential/);
    expect(existsSync(out)).toBe(false);
  });

  it("refuses incognito and tool children before writing", async () => {
    const out = join(dir, "nested", "bk");
    const context = { memoryDbFile: dbFile };
    await expect(createMemoryBackup({ ...context, incognito: true }, out)).rejects.toThrow(/incognito/);
    expect(() => restoreMemoryBackup({ ...context, incognito: true }, out)).toThrow(/incognito/);
    vi.stubEnv("ATOMIC_AGENT_TOOL_CHILD", "");
    await expect(createMemoryBackup(context, out)).rejects.toThrow(/tool subprocesses/);
    expect(() => restoreMemoryBackup(context, out)).toThrow(/tool subprocesses/);
    expect(existsSync(join(dir, "nested"))).toBe(false);
    expect(existsSync(dbFile)).toBe(false);
  });

  it("never overwrites an earlier backup", async () => {
    new MemoryStore({ dbFile, maxEntries: 10 }).close();
    const out = join(dir, "bk");
    expect(await runMemoryBackup(out, { memoryDbFile: dbFile, stateDir: dir, ...quiet() })).toBe(0);
    expect(await runMemoryBackup(out, { memoryDbFile: dbFile, stateDir: dir, ...quiet() })).toBe(2);
  });

  it("no memory yet is a plain failure; the default folder sits under the state dir", async () => {
    expect(await runMemoryBackup(join(dir, "x"), { memoryDbFile: join(dir, "nope.sqlite"), stateDir: dir, ...quiet() })).toBe(1);
    expect(existsSync(join(dir, "x"))).toBe(false);
    expect(defaultBackupDir("/s", new Date(2026, 10, 18, 9, 5, 7))).toBe("/s/backups/memory-20261118-090507");
  });
});
