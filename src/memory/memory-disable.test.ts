import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Database as DatabaseCtor } from "../native/load-better-sqlite3.js";
import { applyMigrations, MEMORY_SCHEMA_VERSION } from "./memory-schema.js";
import { MemoryStore } from "./memory-store.js";
import { restoreMemoryChange } from "./evolution/memory-restore.js";
import { ProfileStore } from "./profile-store.js";

/**
 * ATO-1124: turn one note or profile fact off without deleting it. Off
 * means listed (marked) but never recalled, searched, put in the prompt
 * or consolidated; on again brings it straight back.
 */
describe("turning one memory entry off (ATO-1124)", () => {
  let tmp: string;
  let dbFile: string;
  const stores: Array<{ close(): void }> = [];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-memory-disable-"));
    dbFile = join(tmp, "memory.sqlite");
  });

  afterEach(() => {
    while (stores.length > 0) stores.pop()!.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const notesStore = (opts: Partial<ConstructorParameters<typeof MemoryStore>[0]> = {}): MemoryStore => {
    const store = new MemoryStore({ dbFile, maxEntries: 100, ...opts });
    stores.push(store);
    return store;
  };

  const profileStore = (): ProfileStore => {
    const store = new ProfileStore({ dbFile });
    stores.push(store);
    return store;
  };

  it("records a state change once and restores it without replacing the entry", () => {
    const notes = notesStore();
    const profile = profileStore();
    const note = notes.store({ content: "Meet on Tuesday" });
    const fact = profile.set("city", "Lisbon");
    notes.setDisabled(note.id, true);
    notes.setDisabled(note.id, true);
    profile.setDisabled(fact.key, true);

    const changes = notes.getChangeLog().list();
    expect(changes.map((change) => change.op)).toEqual(["set_disabled", "set_disabled"]);
    for (const change of changes) {
      expect(restoreMemoryChange(change.id, { notes, profile }).ok).toBe(true);
      expect(restoreMemoryChange(change.id, { notes, profile }).ok).toBe(false);
    }
    expect(notes.get(note.id)?.disabledAt).toBeUndefined();
    expect(profile.get(fact.key)?.disabledAt).toBeUndefined();
    expect(profile.history(fact.key)).toHaveLength(1);
  });

  it("keeps recovered entries disabled after undoing a deletion", () => {
    const notes = notesStore();
    const profile = profileStore();
    const note = notes.store({ content: "Meet on Tuesday" });
    const fact = profile.set("city", "Lisbon");
    notes.setDisabled(note.id, true);
    profile.setDisabled(fact.key, true);
    notes.remove(note.id);
    profile.remove(fact.key);
    const changes = notes.getChangeLog().list().filter((change) => change.op === "remove");
    for (const change of changes) expect(restoreMemoryChange(change.id, { notes, profile }).ok).toBe(true);
    expect(notes.get(note.id)?.disabledAt).toEqual(expect.any(Number));
    expect(profile.get(fact.key)?.disabledAt).toEqual(expect.any(Number));
    expect(notes.recall("Tuesday")).toHaveLength(0);
    expect(profile.listForPrompt()).toHaveLength(0);
  });

  it("adds disabled_at in place, without a schema version bump", () => {
    const db = new DatabaseCtor(dbFile);
    try {
      applyMigrations(db);
      applyMigrations(db);
      for (const table of ["memories", "profile_facts"]) {
        const names = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
          (c) => c.name,
        );
        expect(names).toContain("disabled_at");
      }
      const row = db.prepare(`SELECT value FROM schema_meta WHERE key = 'version'`).get() as { value: string };
      expect(Number(row.value)).toBe(MEMORY_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it("keeps a turned-off note listed but out of recall, search and the index", async () => {
    const notes = notesStore();
    const off = notes.store({ content: "the user is allergic to peanuts" });
    const on = notes.store({ content: "the user likes peanut butter cookies" });

    const disabled = notes.setDisabled(off.id, true, 5_000);
    expect(disabled?.disabledAt).toBe(5_000);

    expect(notes.recall("peanuts peanut").map((e) => e.id)).toEqual([on.id]);
    expect((await notes.recallHybridAsync("peanuts peanut")).map((e) => e.id)).toEqual([on.id]);
    expect(notes.findSimilar("allergic to peanuts", 5).map((e) => e.id)).not.toContain(off.id);
    expect(notes.listIndex().map((e) => e.id)).toEqual([on.id]);
    expect(notes.list({ excludeDisabled: true }).map((e) => e.id)).toEqual([on.id]);

    // The person's own list still shows it, marked.
    const listed = notes.list().find((e) => e.id === off.id);
    expect(listed?.disabledAt).toBe(5_000);
    expect(notes.list().find((e) => e.id === on.id)?.disabledAt).toBeUndefined();

    // Turning it off again keeps the first time; on brings it back.
    expect(notes.setDisabled(off.id, true, 9_000)?.disabledAt).toBe(5_000);
    expect(notes.setDisabled(off.id, false)?.disabledAt).toBeUndefined();
    expect(notes.recall("allergic").map((e) => e.id)).toEqual([off.id]);
  });

  it("does not relearn a turned-off note", () => {
    const notes = notesStore({ dedup: { enabled: true, fts5Threshold: 0.5 } });
    const off = notes.store({ content: "the user prefers dark roast coffee" });
    notes.setDisabled(off.id, true);
    const fresh = notes.store({ content: "the user prefers dark roast coffee beans" });
    expect(fresh.id).toBe(off.id);
    expect(notes.count()).toBe(1);
    expect(notes.recall("dark roast")).toEqual([]);
  });

  it("answers null for an unknown note", () => {
    expect(notesStore().setDisabled(999, true)).toBeNull();
  });

  it("keeps a turned-off fact listed but out of the prompt, across new versions", () => {
    const profile = profileStore();
    profile.set("diet", "vegetarian");
    profile.set("city", "Porto");

    expect(profile.setDisabled("diet", true, 7_000)?.disabledAt).toBe(7_000);
    expect(profile.listForPrompt().map((f) => f.key)).toEqual(["city"]);
    expect(profile.list().find((f) => f.key === "diet")?.disabledAt).toBe(7_000);

    // A new value for the key (an edit, or the agent learning it again) stays off.
    profile.set("diet", "vegan");
    expect(profile.get("diet")).toMatchObject({ value: "vegan", disabledAt: 7_000 });
    expect(profile.listForPrompt().map((f) => f.key)).toEqual(["city"]);
    // Turning it off is not a new version.
    expect(profile.history("diet").map((v) => v.value)).toEqual(["vegetarian", "vegan"]);

    expect(profile.setDisabled("diet", false)?.disabledAt).toBeUndefined();
    expect(profile.listForPrompt().map((f) => f.key)).toEqual(["city", "diet"]);
    expect(profileStore().setDisabled("nope", true)).toBeNull();
  });
});
