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

  it("shows a disabled note in the unfiltered list and can enable it", () => {
    const note = store.store({ content: "the kiwi orchard is in the south field" });
    store.setDisabled(note.id, true);
    const emitted: Array<{ type: string; rows?: import("./memory-panel-state.js").MemorySummaryRow[] }> = [];
    const runtime = {
      config: { memory: { notes: { enabled: true }, lessons: {}, procedures: {}, links: {} } },
      notesStore: store,
      voteStore: null,
    };
    const bus = { subscribe: () => () => {}, emit: (action: unknown) => emitted.push(action as never) };
    const orchestrator = new MemoryOrchestrator(runtime as never, bus as never);
    orchestrator.refresh({ channel: "notes" });
    const row = emitted.find((action) => action.type === "memory_rows_loaded")?.rows?.[0];
    expect(row?.meta).toContain("disabled");
    expect(searchIds(true)).toContain(note.id);
    expect(store.get(note.id)?.recallCount).toBe(0);
    orchestrator.toggleDisabled(row!);
    expect(store.get(note.id)?.disabledAt).toBeUndefined();
  });

  it("announces a confirmed restore before entering synchronous work", async () => {
    const emitted: unknown[] = [];
    const runtime = { config: { paths: { memoryDbFile: join(dir, "memory.sqlite") }, memory: { notes: {}, profile: {} } } };
    const bus = { subscribe: () => () => {}, emit: (action: unknown) => emitted.push(action) };
    const orchestrator = new MemoryOrchestrator(runtime as never, bus as never);
    const pending = orchestrator.runBackup({ operation: "restore", directory: join(dir, "missing"), confirmed: true, expectedHash: "0".repeat(64) });
    expect(emitted).toContainEqual({ type: "system_message", text: "Memory restore in progress…" });
    await pending;
    expect(emitted).toContainEqual({ type: "system_message", text: expect.stringContaining("memory restore failed") });
  });

  it("a search leaves superseded notes out while memory.notes.reconcile is on", () => {
    const stale = store.store({ content: "the kiwi orchard is in the south field" });
    const live = store.store({ content: "the kiwi orchard moved to the north field" });
    store.markSuperseded(stale.id, live.id, { leaseMs: 0 });
    expect(searchIds(true)).toEqual([live.id]);
    expect(searchIds(false)).toContain(stale.id);
  });
});
