import { describe, expect, it, vi } from "vitest";

import { userTurn } from "./conversation-turn.js";
import {
  readSessionArchived,
  readSessionArchivedSetAt,
  withSessionArchived,
} from "./session-archived.js";
import { SessionStore } from "./session-store.js";
import { createEmptySessionState, recordTurn } from "./session-state.js";

// ATO-1150: a chat the operator archived, in the session's own metadata.
describe("session archive flag", () => {
  const fresh = () => {
    const store = new SessionStore({ dbFile: ":memory:" });
    const base = {
      ...recordTurn(createEmptySessionState({ id: "s-1", workingDir: "/w" }), userTurn("hello")),
      updatedAt: 1_000,
    };
    store.save(base);
    return { store, base };
  };

  it("reads only a literal true as archived", () => {
    expect(readSessionArchived({ archived: true })).toBe(true);
    expect(readSessionArchived({ archived: "true" })).toBe(false);
    expect(readSessionArchived({})).toBe(false);
    expect(readSessionArchived(undefined)).toBe(false);
  });

  it("archives with archived:true and a stamp, without moving updatedAt; unarchive drops the key", () => {
    const { store } = fresh();
    expect(store.setSessionArchived("s-1", true, 5_000)?.metadata?.archived).toBe(true);
    let loaded = store.load("s-1");
    expect(loaded?.metadata?.archived).toBe(true);
    expect(readSessionArchivedSetAt(loaded?.metadata)).toBe(5_000);
    expect(loaded?.updatedAt).toBe(1_000);

    store.setSessionArchived("s-1", false, 6_000);
    loaded = store.load("s-1");
    expect("archived" in (loaded?.metadata ?? {})).toBe(false);
    expect(readSessionArchived(loaded?.metadata)).toBe(false);
    expect(readSessionArchivedSetAt(loaded?.metadata)).toBe(6_000);
  });

  it("answers null for a session that is not stored", () => {
    const { store } = fresh();
    expect(store.setSessionArchived("missing", true)).toBeNull();
  });

  it("a copy read before the archive (a running turn) does not put the old flag back", () => {
    const { store, base } = fresh();
    store.setSessionArchived("s-1", true, 5_000);
    // `base` was read before the archive: no stamp, no flag.
    store.save({ ...base, updatedAt: 2_000 });
    expect(readSessionArchived(store.load("s-1")?.metadata)).toBe(true);
    store.finishTurn({ ...base, updatedAt: 3_000 });
    expect(readSessionArchived(store.load("s-1")?.metadata)).toBe(true);
  });

  it("a copy stamped earlier loses; one stamped later (a newer unarchive) wins", () => {
    const { store, base } = fresh();
    store.setSessionArchived("s-1", true, 5_000);
    store.save(withSessionArchived(base, false, 4_000));
    expect(readSessionArchived(store.load("s-1")?.metadata)).toBe(true);
    store.save(withSessionArchived(base, false, 7_000));
    expect(readSessionArchived(store.load("s-1")?.metadata)).toBe(false);
  });

  it("isArchived reads the flag in SQL (ATO-1510)", () => {
    const { store } = fresh();
    expect(store.isArchived("s-1")).toBe(false);
    store.setSessionArchived("s-1", true, 5_000);
    expect(store.isArchived("s-1")).toBe(true);
    store.setSessionArchived("s-1", false, 6_000);
    expect(store.isArchived("s-1")).toBe(false);
    expect(store.isArchived("missing")).toBe(false);
  });

  it("the summary page lists the flag", () => {
    const { store } = fresh();
    expect(store.listSummaryPage({ limit: 25 })[0]?.archived).toBe(false);
    store.setSessionArchived("s-1", true, 5_000);
    expect(store.listSummaryPage({ limit: 25 })[0]?.archived).toBe(true);
  });

  it("a summary page can leave archived chats out in SQL, so older ones are reachable", () => {
    const store = new SessionStore({ dbFile: ":memory:" });
    for (let n = 0; n < 45; n += 1) {
      const id = `s-${String(n).padStart(2, "0")}`;
      const base = { ...recordTurn(createEmptySessionState({ id, workingDir: "/w" }), userTurn(`chat ${n}`)), updatedAt: 1_000 + n };
      // The newest 41 are put away.
      store.save(n >= 4 ? withSessionArchived(base, true, 2_000) : base);
    }
    // Without the opt-in every row is listed (the HTTP list shows the flag).
    expect(store.listSummaryPage({ limit: 40 })).toHaveLength(40);
    const page = store.listSummaryPage({ limit: 40, excludeArchived: true });
    expect(page.map((r) => r.id)).toEqual(["s-03", "s-02", "s-01", "s-00"]);
    // The open chat stays even when archived.
    const kept = store.listSummaryPage({ limit: 40, excludeArchived: true, keepId: "s-30" });
    expect(kept.map((r) => r.id)).toEqual(["s-30", "s-03", "s-02", "s-01", "s-00"]);
    store.close();
  });

  it("does not re-create a row deleted between its read and its write (archive and rename)", () => {
    for (const act of [
      (store: SessionStore) => store.setSessionArchived("s-1", true, 5_000),
      (store: SessionStore) => store.renameSession("s-1", "New name", 5_000),
    ]) {
      const { store } = fresh();
      const load = store.load.bind(store);
      // Another process (an incognito discard, a delete) removes the row
      // right after this one read it.
      vi.spyOn(store, "load").mockImplementation((id: string) => {
        const read = load(id);
        store.getDatabaseHandleForRetention().prepare("DELETE FROM sessions WHERE id = ?").run(id);
        return read;
      });
      expect(act(store)).toBeNull();
      vi.restoreAllMocks();
      expect(store.load("s-1")).toBeNull();
      store.close();
    }
  });
});
