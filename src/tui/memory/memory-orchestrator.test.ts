import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryStore } from "../../memory/memory-store.js";
import { MemoryOrchestrator } from "./memory-orchestrator.js";

describe("MemoryOrchestrator notes search", () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-memory-orchestrator-"));
    store = new MemoryStore({ dbFile: join(dir, "memory.sqlite"), maxEntries: 100 });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function searchIds(reconcile: boolean): number[] {
    const emitted: Array<{ type: string; rows?: Array<{ numericId?: number }> }> = [];
    const runtime = {
      config: {
        memory: {
          profile: { enabled: false },
          notes: { enabled: true, reconcile },
          lessons: { enabled: false },
          procedures: { enabled: false },
          links: { enabled: false },
        },
      },
      notesStore: store,
      voteStore: null,
    };
    const bus = { subscribe: () => () => {}, emit: (action: unknown) => emitted.push(action as never) };
    new MemoryOrchestrator(runtime as never, bus as never).refresh({ channel: "notes", searchQuery: "kiwi orchard" });
    const loaded = emitted.find((a) => a.type === "memory_rows_loaded");
    return (loaded?.rows ?? []).map((row) => row.numericId ?? -1);
  }

  it("a search leaves superseded notes out while memory.notes.reconcile is on", () => {
    const stale = store.store({ content: "the kiwi orchard is in the south field" });
    const live = store.store({ content: "the kiwi orchard moved to the north field" });
    store.markSuperseded(stale.id, live.id, { leaseMs: 0 });
    expect(searchIds(true)).toEqual([live.id]);
    expect(searchIds(false)).toContain(stale.id);
  });
});
