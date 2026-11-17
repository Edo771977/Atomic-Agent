import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { currentProviderPolicy, runWithProviderPolicy } from "../llm/provider-policy.js";
import { createEmptySessionState } from "../session/index.js";
import { buildSessionsSearchTool } from "../tools/memory/sessions-search.js";
import { buildSessionsCheckTool } from "../tools/sessions/sessions-check.js";
import { buildSessionsListTool } from "../tools/sessions/sessions-list.js";
import { buildSessionsReadTool } from "../tools/sessions/sessions-read.js";
import { buildSessionsSendTool } from "../tools/sessions/sessions-send.js";
import { frameCrossSessionMessage } from "../tools/sessions/session-access.js";
import { createCrossSessionPolicy } from "./cross-session-policy.js";
import { createSessionProviderPolicy } from "./session-provider-policy.js";
import { createSessionReadTaint, readTaintOf } from "./session-read-taint.js";

/**
 * Issue #33 on upstream's cross-chat tools (ATO-570, ATO-1151): another
 * chat's transcript carries its folder's constraint into the session
 * that reads it, a search never lists a chat the caller may not see, and
 * a message queued into another chat carries the sender's constraint.
 */
describe("cross-session policy", () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  function setup() {
    root = mkdtempSync(join(tmpdir(), "cross-session-"));
    const secret = join(root, "secret");
    const open = join(root, "open");
    for (const dir of [secret, open]) mkdirSync(dir, { recursive: true });
    const config = { projects: { roots: [], constraints: { [secret]: { allowedProviders: ["local-llama"] } } } };
    const stored = new Map<string, ReturnType<typeof createEmptySessionState>>();
    const add = (id: string, workingDir: string) => {
      const state = createEmptySessionState({ id, workingDir, metadata: { title: id } });
      stored.set(id, state);
      return state;
    };
    add("s-open", open);
    add("s-secret", secret);
    add("s-other", open);
    const readTaint = createSessionReadTaint({
      readConfig: () => config,
      patchStoredSession: (id, patch) => {
        const s = stored.get(id);
        if (s) s.metadata = patch(s.metadata ?? {});
      },
    });
    const policy = createSessionProviderPolicy({ readConfig: () => config, loadSession: (id) => stored.get(id) ?? null });
    const cross = createCrossSessionPolicy({ policy, readTaint });
    const approvals = { request: vi.fn(async () => ({ approved: true })) } as never;
    const ctx = (sessionId: string, workingDir: string) => ({
      sessionId, workingDir, stepIndex: 0, signal: new AbortController().signal,
    });
    const inOpenTurn = <T>(fn: () => Promise<T>): Promise<T> =>
      readTaint.inTurn(stored.get("s-open")!, () => runWithProviderPolicy(undefined, fn, { sessionId: "s-open" }));
    return { secret, open, stored, readTaint, policy, cross, approvals, ctx, inOpenTurn };
  }

  it("sessions.read of a constrained chat taints the reader with that chat's constraint", async () => {
    const t = setup();
    const tool = buildSessionsReadTool({
      approvals: t.approvals,
      approvalRequired: true,
      sessionStore: { load: (id) => t.stored.get(id) ?? null, listChatLines: () => [{ kind: "user", text: "the contract" }] },
      crossSession: t.cross,
    });
    await t.inOpenTurn(() => tool.run({ sessionId: "s-secret" }, t.ctx("s-open", t.open)));
    expect(readTaintOf(t.stored.get("s-open")!.metadata)?.key).toBe(t.secret);
  });

  it("sessions.read of an unconstrained chat leaves the reader as it was", async () => {
    const t = setup();
    const tool = buildSessionsReadTool({
      approvals: t.approvals,
      approvalRequired: true,
      sessionStore: { load: (id) => t.stored.get(id) ?? null, listChatLines: () => [] },
      crossSession: t.cross,
    });
    await t.inOpenTurn(() => tool.run({ sessionId: "s-other" }, t.ctx("s-open", t.open)));
    expect(readTaintOf(t.stored.get("s-open")!.metadata)).toBeUndefined();
  });

  it("sessions.check brings the answer of a constrained chat in with its constraint", async () => {
    const t = setup();
    const message = frameCrossSessionMessage("s-open", "summarise it");
    const tool = buildSessionsCheckTool({
      taskStore: { get: () => ({ id: "t1", sessionId: "s-secret", status: "completed", userMessage: message }) as never },
      sessionStore: { listChatLines: () => [{ kind: "user", text: message }, { kind: "assistant_reply", text: "the clause says" }] },
      crossSession: t.cross,
    });
    const result = await t.inOpenTurn(() => tool.run({ taskId: "t1" }, t.ctx("s-open", t.open)));
    expect(result.summary).toContain("the clause says");
    expect(readTaintOf(t.stored.get("s-open")!.metadata)?.key).toBe(t.secret);
  });

  it("memory.sessions.search lists no hit of a chat the caller may not see, and a read of one taints", async () => {
    const t = setup();
    const hit = (sessionId: string) => ({ sessionId, title: sessionId, line: 0, kind: "user", snippet: `[${sessionId}]`, source: "chat", updatedAt: 0 });
    const tool = buildSessionsSearchTool({
      source: {
        searchTranscripts: () => ({ hits: [hit("s-secret"), hit("s-other")] as never, pending: 0 }),
        listSearchableChatLines: () => [{ kind: "user", text: "the contract" }] as never,
      },
      crossSession: t.cross,
    });
    const found = await t.inOpenTurn(() => tool.run({ query: "contract" }, t.ctx("s-open", t.open)));
    expect(found.summary).toContain("s-other");
    expect(found.summary).not.toContain("s-secret");
    // Under the secret folder's own policy the hit is visible.
    const inside = await runWithProviderPolicy(t.policy.forSessionId("s-secret"), () =>
      tool.run({ query: "contract" }, t.ctx("s-secret", t.secret)));
    expect(inside.summary).toContain("s-other");
    await t.inOpenTurn(() => tool.run({ sessionId: "s-secret" }, t.ctx("s-open", t.open)));
    expect(readTaintOf(t.stored.get("s-open")!.metadata)?.key).toBe(t.secret);
  });

  it("sessions.list names no chat the caller may not see, and a query does not match its words", async () => {
    const t = setup();
    t.stored.get("s-secret")!.metadata = { title: "Acme contract" };
    const rows = [
      { id: "s-secret", status: "idle", updatedAt: 2, title: "Acme contract", firstPrompt: "read the Acme contract" },
      { id: "s-other", status: "idle", updatedAt: 1, title: "Acme lunch", firstPrompt: null },
    ];
    const tool = buildSessionsListTool({
      sessionStore: { listSummaryPage: () => rows as never },
      crossSession: t.cross,
    });
    const listed = await t.inOpenTurn(() => tool.run({}, t.ctx("s-open", t.open)));
    expect(listed.summary).toContain("Acme lunch");
    expect(listed.summary).not.toContain("Acme contract");
    expect(listed.summary).toContain("s-secret");
    const found = await t.inOpenTurn(() => tool.run({ query: "contract" }, t.ctx("s-open", t.open)));
    expect(found.summary).not.toContain("s-secret");
  });

  it("sessions.send carries a constrained sender's constraint into the chat it queues into", async () => {
    const t = setup();
    const created: string[] = [];
    const tool = buildSessionsSendTool({
      approvals: t.approvals,
      approvalRequired: true,
      sessionStore: { load: (id) => t.stored.get(id) ?? null },
      taskRunner: { create: (input) => { created.push(input.sessionId!); return { id: "t1" } as never; } },
      createSession: () => { throw new Error("unused"); },
      defaultMaxAttempts: 1,
      crossSession: t.cross,
    });
    const secretTurn = <T>(fn: () => Promise<T>): Promise<T> =>
      t.readTaint.inTurn(t.stored.get("s-secret")!, () =>
        runWithProviderPolicy(t.policy.forSessionId("s-secret"), fn, { sessionId: "s-secret" }));
    const result = await secretTurn(() => tool.run({ sessionId: "s-other", message: "what does it say?" }, t.ctx("s-secret", t.secret)));
    expect(result.status).toBe("ok");
    expect(created).toEqual(["s-other"]);
    expect(readTaintOf(t.stored.get("s-other")!.metadata)?.key).toBe(t.secret);
    expect(currentProviderPolicy()).toBeUndefined();
  });
});
