import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDefaultMemoryContextProvider } from "./memory-context-provider.js";
import { MemoryStore } from "./memory-store.js";
import { NeighborEvolver } from "./evolution/index.js";
import { buildNotesStoreTool } from "../tools/memory/notes-store.js";

describe("superseded notes (ATO-672)", () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-memory-supersede-"));
    store = new MemoryStore({ dbFile: join(dir, "memory.sqlite"), maxEntries: 100 });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("list({ excludeTags }) drops rows carrying the tag", () => {
    const a = store.store({ content: "works at Acme", tags: ["reflection"] });
    store.store({ content: "works at Globex" });
    store.markSuperseded(a.id, 999, { leaseMs: 0 });
    expect(store.list({ excludeTags: ["superseded"] }).map((e) => e.content)).toEqual([
      "works at Globex",
    ]);
    expect(store.list()).toHaveLength(2);
  });

  it("findSimilar does not count as a recall", () => {
    const a = store.store({ content: "the user works at Acme" });
    const hits = store.findSimilar("the user works at Globex", 5);
    expect(hits.map((e) => e.id)).toContain(a.id);
    expect(store.get(a.id)!.recallCount).toBe(0);
  });

  it("the context provider hides superseded notes only when asked", async () => {
    const old = store.store({ content: "lisbon office address" });
    store.store({ content: "lisbon office moved to the new address" });
    store.markSuperseded(old.id, 999, { leaseMs: 0 });
    const input = {
      sessionId: "s1",
      userMessage: "lisbon office",
      toolResultSummaries: [],
      signal: new AbortController().signal,
    };
    const build = async (hideSuperseded: boolean) =>
      (await createDefaultMemoryContextProvider({
        store,
        recall: { enabled: true, k: 5 },
        index: { enabled: true, limit: 20, previewChars: 80 },
        ...(hideSuperseded ? { hideSuperseded: true } : {}),
      }).buildMemoryContext(input)) as unknown as {
        recalled: Array<{ id: number }>;
        index: Array<{ id: number }>;
      };
    const on = await build(true);
    expect(on.recalled.map((e) => e.id)).not.toContain(old.id);
    expect(on.index.map((e) => e.id)).not.toContain(old.id);
    const off = await build(false);
    expect(off.recalled.map((e) => e.id)).toContain(old.id);
  });

  describe("reserved supersede tags", () => {
    const reserved = ["superseded", "Superseded", "superseded-by-7"];

    it("store() strips them: a writer cannot hide its own or another note", () => {
      const a = store.store({ content: "the deploy key lives in the vault", tags: ["ops", ...reserved] });
      expect(a.tags).toEqual(["ops"]);
      expect(store.get(a.id)!.tags).toEqual(["ops"]);
    });

    it("a dedup merge cannot add them to an existing note", () => {
      const deduping = new MemoryStore({ dbFile: join(dir, "dedup.sqlite"), maxEntries: 100, dedup: { enabled: true } });
      try {
        const real = deduping.store({ content: "the user deploys from the main branch every friday", tags: ["user"] });
        const merged = deduping.store({ content: "the user deploys from the main branch every friday", tags: ["superseded", "superseded-by-1"] });
        expect(merged.id).toBe(real.id);
        expect(deduping.get(real.id)!.tags).toEqual(["user"]);
      } finally {
        deduping.close();
      }
    });

    it("evolveTags() (tag evolution) cannot set them", () => {
      const a = store.store({ content: "uses pnpm in this repo", tags: ["tooling"] });
      const result = store.evolveTags(a.id, ["superseded", "superseded-by-3"], { leaseMs: 0 });
      expect(result.outcome).toBe("skipped_no_change");
      expect(store.get(a.id)!.tags).toEqual(["tooling"]);
      store.evolveTags(a.id, ["pnpm", "superseded"], { leaseMs: 0 });
      expect(store.get(a.id)!.tags).toEqual(["tooling", "pnpm"]);
    });

    it("the neighbour evolver's EVOLVE path cannot set them", () => {
      const target = store.store({ content: "the staging database is postgres 16", tags: ["db"] });
      new NeighborEvolver({ memoryStore: store, leaseMs: 0 }).apply({
        sessionId: "s1",
        evolves: [{ targetId: target.id, addTags: ["superseded", "superseded-by-5"] }],
      });
      expect(store.get(target.id)!.tags).toEqual(["db"]);
    });

    it("the memory.notes.store tool cannot set them", async () => {
      const tool = buildNotesStoreTool({ store, maxContentChars: 4_000 });
      const result = await tool.run({ content: "hide me please", tags: ["superseded", "superseded-by-2", "x"] },
        { workingDir: "/work", sessionId: "s1", stepIndex: 0, signal: new AbortController().signal });
      expect(store.get(result.details.id as number)!.tags).toEqual(["x"]);
    });

    it("markSuperseded() (the reconciler's method) sets them", () => {
      const a = store.store({ content: "office is in lisbon", tags: ["place"] });
      const result = store.markSuperseded(a.id, 42, { leaseMs: 0 });
      expect(result.outcome).toBe("applied");
      expect(store.get(a.id)!.tags).toEqual(["place", "superseded", "superseded-by-42"]);
    });
  });
});
