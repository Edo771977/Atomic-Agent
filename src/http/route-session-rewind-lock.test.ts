import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createEmptySessionState, type SessionState } from "../session/index.js";

import { startTestHarness, type Harness } from "./test-harness.js";

/** Lets the test act while the rewind is restoring files (issue #74 item 17). */
const hooks = vi.hoisted(() => ({ duringRestore: null as null | (() => Promise<void>) }));

vi.mock("../tools/os/fs/fs-checkpoint-restore.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools/os/fs/fs-checkpoint-restore.js")>();
  return {
    ...actual,
    applyFileRestore: async (...args: Parameters<typeof actual.applyFileRestore>) => {
      await hooks.duringRestore?.();
      return actual.applyFileRestore(...args);
    },
  };
});

describe("rewind holds the chat's turn lock", () => {
  let harness: Harness;
  beforeEach(async () => { harness = await startTestHarness(); });
  afterEach(async () => { hooks.duringRestore = null; await harness.cleanup(); });

  it("a turn sent while files are restored runs after the rewind instead of being overwritten", async () => {
    const state: SessionState = {
      ...createEmptySessionState({ id: "rw-lock", workingDir: harness.workingDir }),
      status: "completed",
      turns: [
        { kind: "user", text: "first", at: 100 },
        { kind: "assistant_reply", text: "one", at: 110 },
        { kind: "user", text: "second", at: 200 },
        { kind: "assistant_reply", text: "two", at: 210 },
      ],
      turnCount: 2,
      macroTurnStarts: [2, 4],
    };
    harness.runtime.sessionStore.save(state);
    let turn: Promise<unknown> | undefined;
    hooks.duringRestore = async () => {
      hooks.duringRestore = null;
      const latest = harness.runtime.sessionStore.load("rw-lock")!;
      turn = harness.runtime.runTurn(latest, "sent during the rewind", { origin: "http" });
      // Give an unlocked turn every chance to finish before the rewind saves.
      await Promise.race([turn.catch(() => undefined), new Promise((r) => setTimeout(r, 1000))]);
    };
    const res = await fetch(`${harness.baseUrl}/api/sessions/rw-lock/rewind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ priorQuestions: 1, expectText: "second" }),
    });
    expect(res.status).toBe(200);
    await turn;
    const stored = harness.runtime.sessionStore.load("rw-lock")!;
    const texts = stored.turns.filter((t) => t.kind === "user").map((t) => (t as { text: string }).text);
    expect(texts).toEqual(["first", "sent during the rewind"]);
  });
});
