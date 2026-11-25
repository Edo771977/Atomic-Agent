import { assertAuxiliaryArchive } from "../../privacy/auxiliary-isolation-fixture.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CompletionResult } from "../../llm/llama-server-client.js";
import { createDefaultMemoryContextProvider } from "../memory-context-provider.js";
import { MEMORY_MAX_TAGS, MemoryStore } from "../memory-store.js";
import type { ReflectionRunner } from "../reflection/reflection-runner.js";

import {
  createNoteReconcileRunner,
  isSupersededNote,
  type NoteReconcileLlmComplete,
} from "./note-reconcile-runner.js";
import { createReconcileAwareReflectionRunner } from "./reconcile-aware-reflection.js";

function completion(content: string): CompletionResult {
  return {
    content,
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: { promptMs: 0, predictedMs: 0, promptTokens: 0, predictedTokens: 0 },
    cacheHitTokens: 0,
    slotId: 0,
    modelId: null,
  };
}

describe("note reconciliation (ATO-672)", () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-note-reconcile-"));
    store = new MemoryStore({ dbFile: join(dir, "memory.sqlite"), maxEntries: 100 });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function runner(llm: NoteReconcileLlmComplete, timeoutMs = 1_000) {
    return createNoteReconcileRunner({
      llmComplete: llm,
      notesStore: store,
      reflectionSlotId: 0,
      timeoutMs,
    });
  }

  it("marks the older note the new one replaces as superseded", async () => {
    const old = store.store({ content: "The user works at Acme as a designer", tags: ["reflection"] });
    const fresh = store.store({ content: "The user now works at Globex as a designer", tags: ["reflection"] });
    let prompt = "";
    const report = await runner(async (p) => {
      prompt = p.prompt;
      return completion(`SUPERSEDE ${old.id}\n`);
    }).reconcile({ sessionId: "s1", notes: [fresh] });
    expect(report).toEqual({ outcome: "superseded", marked: [old.id] });
    expect(prompt).toContain(`[${old.id}]`);
    const after = store.get(old.id)!;
    expect(isSupersededNote(after)).toBe(true);
    expect(after.tags).toContain(`superseded-by-${fresh.id}`);
    expect(after.content).toBe("The user works at Acme as a designer");
    expect(isSupersededNote(store.get(fresh.id)!)).toBe(false);
  });

  it("marks a note that already has the maximum number of tags", async () => {
    const fullTags = Array.from({ length: MEMORY_MAX_TAGS }, (_, i) => `topic-${i}`);
    const old = store.store({ content: "The lisbon office address is Rua Augusta 10", tags: fullTags });
    const fresh = store.store({ content: "The lisbon office moved to the new address Rua Garrett 5" });
    const report = await runner(async () => completion(`SUPERSEDE ${old.id}\n`)).reconcile({
      sessionId: "s1",
      notes: [fresh],
    });
    expect(report.marked).toContain(old.id);
    const after = store.get(old.id)!;
    expect(isSupersededNote(after)).toBe(true);
    expect(after.tags).toContain(`superseded-by-${fresh.id}`);
    expect(after.tags.length).toBeLessThanOrEqual(MEMORY_MAX_TAGS);

    const context = (await createDefaultMemoryContextProvider({
      store,
      recall: { enabled: true, k: 5 },
      index: { enabled: true, limit: 20, previewChars: 80 },
      hideSuperseded: true,
    }).buildMemoryContext({
      sessionId: "s1",
      userMessage: "lisbon office address",
      toolResultSummaries: [],
      signal: new AbortController().signal,
    })) as unknown as { recalled: Array<{ id: number }>; index: Array<{ id: number }> };
    expect(context.recalled.map((e) => e.id)).not.toContain(old.id);
    expect(context.index.map((e) => e.id)).not.toContain(old.id);
  });

  it("marks the NEW note on DUPLICATE", async () => {
    const old = store.store({ content: "The user prefers dark mode in every editor" });
    const fresh = store.store({ content: "User likes dark mode for the editor" });
    const report = await runner(async () => completion(`DUPLICATE ${old.id}\n`)).reconcile({
      sessionId: "s1",
      notes: [fresh],
    });
    expect(report.outcome).toBe("duplicate");
    expect(isSupersededNote(store.get(fresh.id)!)).toBe(true);
    expect(isSupersededNote(store.get(old.id)!)).toBe(false);
  });

  it("only compares with notes of the same working directory", async () => {
    const elsewhere = store.store({ content: "The deploy target is the staging cluster", workingDir: "/other-project" });
    const fresh = store.store({ content: "The deploy target is now the production cluster", workingDir: "/project" });
    let shown = "";
    const report = await runner(async (p) => {
      shown = p.prompt;
      return completion(`SUPERSEDE ${elsewhere.id}\n`);
    }).reconcile({ sessionId: "s1", notes: [fresh] });
    expect(report.outcome).toBe("skipped");
    expect(shown).not.toContain(`[${elsewhere.id}]`);
    expect(isSupersededNote(store.get(elsewhere.id)!)).toBe(false);
  });

  it("a global note is compared only with global notes", async () => {
    const scoped = store.store({ content: "The user prefers tabs for indentation", workingDir: "/project" });
    const fresh = store.store({ content: "The user prefers spaces for indentation now" });
    const report = await runner(async () => completion(`SUPERSEDE ${scoped.id}\n`)).reconcile({ sessionId: "s1", notes: [fresh] });
    expect(report.outcome).toBe("skipped");
    expect(isSupersededNote(store.get(scoped.id)!)).toBe(false);
  });

  it("never marks a note the user stored explicitly", async () => {
    const explicit = store.store({ content: "The user works at Acme as a designer", source: "user", workingDir: "/project" });
    const fresh = store.store({ content: "The user now works at Globex as a designer", tags: ["reflection"], workingDir: "/project" });
    const report = await runner(async () => completion(`SUPERSEDE ${explicit.id}\n`)).reconcile({ sessionId: "s1", notes: [fresh] });
    expect(report.marked).toEqual([]);
    expect(isSupersededNote(store.get(explicit.id)!)).toBe(false);
  });

  it("makes no model call when no older note shares words", async () => {
    const fresh = store.store({ content: "zebra quantum lighthouse" });
    let calls = 0;
    const report = await runner(async () => {
      calls += 1;
      return completion("NONE");
    }).reconcile({ sessionId: "s1", notes: [fresh] });
    expect(report.outcome).toBe("skipped");
    expect(calls).toBe(0);
  });

  it("makes no model call when older notes share only common words", async () => {
    store.store({ content: "The user lives in Lisbon and walks to the office" });
    store.store({ content: "The user has a cat named Miso" });
    const fresh = store.store({ content: "The user drinks green tea in the morning" });
    let calls = 0;
    const report = await runner(async () => {
      calls += 1;
      return completion("NONE");
    }).reconcile({ sessionId: "s1", notes: [fresh] });
    expect(report.outcome).toBe("skipped");
    expect(calls).toBe(0);
  });

  it("makes at most one model call for several new notes", async () => {
    store.store({ content: "The user lives in Lisbon" });
    store.store({ content: "The user drinks green tea" });
    const a = store.store({ content: "The user moved to Porto from Lisbon" });
    const b = store.store({ content: "The user switched to green coffee from tea" });
    let calls = 0;
    await runner(async () => {
      calls += 1;
      return completion("NONE\n");
    }).reconcile({ sessionId: "s1", notes: [a, b] });
    expect(calls).toBe(1);
  });

  it("ignores ids the model was not shown", async () => {
    const unrelated = store.store({ content: "zebra quantum lighthouse" });
    store.store({ content: "The user works at Acme" });
    const fresh = store.store({ content: "The user works at Globex now" });
    const report = await runner(async () => completion(`SUPERSEDE ${unrelated.id}\n`)).reconcile({
      sessionId: "s1",
      notes: [fresh],
    });
    expect(report.outcome).toBe("none");
    expect(isSupersededNote(store.get(unrelated.id)!)).toBe(false);
  });

  it("gives up on timeout without marking anything", async () => {
    const old = store.store({ content: "The user works at Acme" });
    const fresh = store.store({ content: "The user works at Globex now" });
    const report = await runner(
      (p) =>
        new Promise<CompletionResult>((_, reject) => {
          p.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
      10,
    ).reconcile({ sessionId: "s1", notes: [fresh] });
    expect(report.outcome).toBe("timeout");
    expect(isSupersededNote(store.get(old.id)!)).toBe(false);
  });

  it("reports every outcome for memory health and backs off after a timeout", async () => {
    store.store({ content: "The user works at Acme" });
    const fresh = store.store({ content: "The user works at Globex now" });
    const outcomes: string[] = [];
    let calls = 0;
    let hang = true;
    const reconciler = createNoteReconcileRunner({
      llmComplete: (p) => { assertAuxiliaryArchive(p.sessionId);
        calls += 1;
        if (!hang) return Promise.resolve(completion("NONE\n"));
        return new Promise<CompletionResult>((_, reject) => {
          p.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      },
      notesStore: store,
      reflectionSlotId: 0,
      timeoutMs: 10,
      timeoutBackoff: { baseCalls: 2, maxCalls: 8 },
      onOutcome: (sessionId, outcome) => outcomes.push(`${sessionId}:${outcome}`),
    });
    expect((await reconciler.reconcile({ sessionId: "s1", notes: [fresh] })).outcome).toBe("timeout");
    expect(calls).toBe(1);
    // The next two calls are skipped without reaching the model.
    expect((await reconciler.reconcile({ sessionId: "s1", notes: [fresh] })).outcome).toBe("skipped");
    expect((await reconciler.reconcile({ sessionId: "s1", notes: [fresh] })).outcome).toBe("skipped");
    expect(calls).toBe(1);
    // Another session is not held back.
    hang = false;
    expect((await reconciler.reconcile({ sessionId: "s2", notes: [fresh] })).outcome).toBe("none");
    expect(calls).toBe(2);
    expect((await reconciler.reconcile({ sessionId: "s1", notes: [fresh] })).outcome).toBe("none");
    expect(calls).toBe(3);
    expect(outcomes).toEqual(["s1:timeout", "s1:skipped", "s1:skipped", "s2:none", "s1:none"]);
  });

  it("the decorator reconciles only notes this reflection wrote", async () => {
    const old = store.store(
      { content: "The user works at Acme", sessionId: "s1", tags: ["reflection"] },
      Date.now() - 10_000,
    );
    let seen: number[] = [];
    const reflection: ReflectionRunner = {
      async reflect() {
        store.store({
          content: "The user works at Globex now",
          sessionId: "s1",
          tags: ["reflection"],
        }, Date.now() + 5);
      },
      abortPending() {},
    };
    const decorated = createReconcileAwareReflectionRunner({
      reflection,
      reconciler: {
        async reconcile(input) {
          seen = input.notes.map((n) => n.id);
          return { outcome: "none", marked: [] };
        },
        abortPending() {},
      },
      notesStore: store,
    });
    await decorated.reflect({ sessionId: "s1", userMessage: "u", assistantReply: "a" });
    expect(seen).toHaveLength(1);
    expect(seen).not.toContain(old.id);
  });

  it("the decorator ignores notes other writers stored during the reflection", async () => {
    let seen: number[] = [];
    let own = -1;
    const reflection: ReflectionRunner = {
      async reflect() {
        // Another session's reflection, and a notes-tool write (it carries a
        // working directory) that copied the reflection tag.
        for (let i = 0; i < 12; i += 1) store.store({ content: `other session note ${i}`, sessionId: "s2", tags: ["reflection"] });
        store.store({ content: "tool note tagged like reflection", sessionId: "s1", workingDir: "/work", tags: ["reflection"] });
        own = store.store({ content: "The user works at Globex now", sessionId: "s1", tags: ["reflection"] }).id;
        for (let i = 0; i < 12; i += 1) store.store({ content: `later other note ${i}`, sessionId: "s3", tags: ["reflection"] });
      },
      abortPending() {},
    };
    const decorated = createReconcileAwareReflectionRunner({
      reflection,
      reconciler: {
        async reconcile(input) {
          seen = input.notes.map((n) => n.id);
          return { outcome: "none", marked: [] };
        },
        abortPending() {},
      },
      notesStore: store,
    });
    await decorated.reflect({ sessionId: "s1", userMessage: "u", assistantReply: "a" });
    expect(seen).toEqual([own]);
  });

  it("the decorator stays fire-safe when the store is closed", async () => {
    const reflection: ReflectionRunner = {
      async reflect() {
        store.close();
      },
      abortPending() {},
    };
    const decorated = createReconcileAwareReflectionRunner({
      reflection,
      reconciler: {
        reconcile: async () => ({ outcome: "none", marked: [] }),
        abortPending() {},
      },
      notesStore: store,
    });
    await expect(
      decorated.reflect({ sessionId: "s1", userMessage: "u", assistantReply: "a" }),
    ).resolves.toBeUndefined();
    // Reopen so afterEach can close it.
    store = new MemoryStore({ dbFile: join(dir, "memory.sqlite"), maxEntries: 100 });
  });
});
