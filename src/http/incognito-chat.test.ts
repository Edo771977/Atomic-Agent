import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FileCheckpointStore } from "../tools/os/fs/fs-checkpoint-store.js";
import type { CompletionResult } from "../llm/llama-server-client.js";

import { deriveChatSessionId } from "./openai-session-id.js";
import { startTestHarness, type Harness } from "./test-harness.js";

/** ATO-586: `incognito: true` on a new chat over HTTP (the desktop's path). */

function reply(text: string) {
  return async (): Promise<CompletionResult> => ({
    content: JSON.stringify({ tool: "reply", args: { text } }),
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: { promptMs: 0, predictedMs: 0, promptTokens: 4, predictedTokens: 2 },
    cacheHitTokens: 0,
    slotId: 0,
    modelId: null,
  });
}

describe("incognito chats over HTTP", () => {
  let harness: Harness;
  const complete = vi.fn(reply("hi back"));

  beforeEach(async () => {
    complete.mockClear();
    harness = await startTestHarness({ llamaComplete: complete });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  const chat = async (body: Record<string, unknown>): Promise<string> => {
    const response = await fetch(`${harness.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "atomic-agent", messages: [{ role: "user", content: "hello" }], ...body }),
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { session_id: string }).session_id;
  };

  const listed = async (): Promise<string[]> => {
    const response = await fetch(`${harness.baseUrl}/api/sessions?scope=all`);
    return ((await response.json()) as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id);
  };

  it("opens a marked chat under its own id, never the derived one", async () => {
    const id = await chat({ incognito: true });
    expect(id).not.toBe(deriveChatSessionId(null, "hello"));
    expect(harness.runtime.sessionStore.load(id)?.incognito).toBeDefined();
    // The same opening prompt in an ordinary chat is a different chat.
    const plain = await chat({});
    expect(plain).toBe(deriveChatSessionId(null, "hello"));
    expect(harness.runtime.sessionStore.load(plain)?.incognito).toBeUndefined();
  });

  it("is never listed, and continues by session_id", async () => {
    const id = await chat({ incognito: true });
    expect(await listed()).not.toContain(id);
    const again = await chat({ session_id: id });
    expect(again).toBe(id);
    expect(harness.runtime.sessionStore.load(id)?.incognito).toBeDefined();
    expect(await listed()).not.toContain(id);
  });

  it("DELETE removes the chat and its trace file", async () => {
    const id = await chat({ incognito: true });
    const response = await fetch(`${harness.baseUrl}/api/sessions/${id}`, { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(harness.runtime.sessionStore.load(id)).toBeNull();
    expect(existsSync(join(harness.stateDir, "traces", `${id}.ndjson`))).toBe(false);
  });

  it("keeps a private chat retryable when deleting its tasks fails", async () => {
    const id = await chat({ incognito: true });
    const task = harness.runtime.taskStore.create({
      sessionId: id, userMessage: "private prompt", origin: "cli", maxAttempts: 1,
      schedule: { kind: "interval", everyMs: 300_000 }, scheduledFor: Date.now() + 300_000,
    });
    vi.spyOn(harness.runtime.taskStore, "removeForSession").mockImplementationOnce(() => {
      throw new Error("SQLITE_BUSY");
    });
    const remove = () => fetch(`${harness.baseUrl}/api/sessions/${id}`, { method: "DELETE" });
    const failed = await remove();
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ error: { code: "incognito_cleanup_failed" } });
    expect(harness.runtime.sessionStore.load(id)?.incognito).toBeDefined();
    expect(harness.runtime.taskStore.get(task.id)).not.toBeNull();
    expect((await remove()).status).toBe(200);
    expect(harness.runtime.sessionStore.load(id)).toBeNull();
    expect(harness.runtime.taskStore.get(task.id)).toBeNull();
  });

  it("purges a recurring private task whose session row was lost", async () => {
    const id = await chat({ incognito: true });
    const task = harness.runtime.taskStore.create({
      sessionId: id, userMessage: "private prompt", origin: "cli", maxAttempts: 1,
      schedule: { kind: "interval", everyMs: 300_000 }, scheduledFor: Date.now() + 300_000,
    });
    expect(harness.runtime.taskStore.get(task.id)?.incognito).toBe(true);
    // Simulate the legacy fallback that dropped the session without purging tasks.
    harness.runtime.sessionStore.delete(id);
    const sessions = await listed();
    complete.mockClear();
    await harness.runtime.taskRunner.runOne(task.id);
    expect(complete).not.toHaveBeenCalled();
    expect(await listed()).toEqual(sessions);
    expect(harness.runtime.taskStore.get(task.id)).toBeNull();
    expect(harness.runtime.taskStore.listRuns(task.id)).toEqual([]);
  });

  it("refuses incognito: true on an existing ordinary chat, which would remember", async () => {
    const plain = await chat({});
    const response = await fetch(`${harness.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "atomic-agent", messages: [{ role: "user", content: "secret" }], session_id: plain, incognito: true }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string; param?: string } };
    expect(body.error.message).toMatch(/incognito/);
    expect(harness.runtime.sessionStore.load(plain)?.incognito).toBeUndefined();
    expect(JSON.stringify(harness.runtime.sessionStore.load(plain))).not.toContain("secret");
  });

  it("an incognito chat stays incognito when a later request leaves the field out or says false", async () => {
    const id = await chat({ incognito: true });
    expect(await chat({ session_id: id, incognito: false })).toBe(id);
    expect(harness.runtime.sessionStore.load(id)?.incognito).toBeDefined();
  });

  it("retries a private chat after server close could not write the cleanup marker", async () => {
    const id = await chat({ incognito: true });
    const marker = vi.spyOn(FileCheckpointStore.prototype, "markIncognitoRemoval").mockImplementationOnce(() => {
      throw new Error("ENOSPC");
    });
    try {
      await harness.handle.close();
      expect(marker).toHaveBeenCalledWith(id);
      expect(harness.runtime.sessionStore.load(id)?.incognito).toBeDefined();
      await harness.handle.close();
      expect(harness.runtime.sessionStore.load(id)).toBeNull();
    } finally {
      marker.mockRestore();
    }
  });

  it("closing the server discards the incognito chats it opened", async () => {
    const id = await chat({ incognito: true });
    const plain = await chat({});
    await harness.handle.close();
    expect(harness.runtime.sessionStore.load(id)).toBeNull();
    expect(harness.runtime.sessionStore.load(plain)).not.toBeNull();
  });
});
