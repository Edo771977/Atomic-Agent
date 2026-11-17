import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startTestHarness, type Harness } from "./test-harness.js";

interface IdeaJson {
  id: string;
  kind: string;
  status: string;
  title: string;
  reason: string;
  evidence: { source: string; ref: string; excerpt: string };
  prompt: string;
  sourceTaskId: string | null;
  taskId: string | null;
}

describe("/api/ideas", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startTestHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  function failedTask(message: string): string {
    const store = harness.runtime.taskStore;
    const t = store.create({ userMessage: message, origin: "cli", maxAttempts: 1 });
    store.markRunning(t.id);
    store.markFailed(t.id, { category: "transport", message: "provider timed out" });
    return t.id;
  }

  async function post(path: string, body?: unknown): Promise<Response> {
    return fetch(`${harness.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  it("refresh offers a failed task with its evidence; list returns it", async () => {
    const taskId = failedTask("tidy the inbox");
    const res = await post("/api/ideas/refresh");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ideas: IdeaJson[]; added: string[] };
    expect(body.added).toHaveLength(1);
    expect(body.ideas[0]).toMatchObject({
      kind: "retry_task",
      status: "new",
      prompt: "tidy the inbox",
      evidence: { source: "task", ref: taskId, excerpt: "provider timed out" },
    });
    const listRes = await fetch(`${harness.baseUrl}/api/ideas?status=new`);
    const list = (await listRes.json()) as { ideas: IdeaJson[] };
    expect(list.ideas.map((i) => i.id)).toEqual([body.ideas[0]!.id]);
  });

  it("accept files a task with the edited prompt; a second accept is 409", async () => {
    failedTask("tidy the inbox");
    const refreshed = (await (await post("/api/ideas/refresh")).json()) as { ideas: IdeaJson[] };
    const id = refreshed.ideas[0]!.id;
    const res = await post(`/api/ideas/${id}/accept`, { prompt: "tidy the inbox, skip spam" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { idea: IdeaJson; task: { id: string } };
    expect(body.idea).toMatchObject({ status: "accepted", taskId: body.task.id });
    expect(harness.runtime.taskStore.get(body.task.id)?.userMessage).toBe("tidy the inbox, skip spam");
    expect(harness.runtime.taskStore.get(body.task.id)?.origin).toBe("http");

    const again = await post(`/api/ideas/${id}/accept`);
    expect(again.status).toBe(409);
    const err = (await again.json()) as { error: { code: string } };
    expect(err.error.code).toBe("idea_decided");
  });

  it("accepting a Retry keeps the original's folder, limits and notify (ATO-458 review)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "idea-retry-p-"));
    try {
      const session = harness.runtime.createSession({ metadata: { source: "http-task" }, persist: false });
      harness.runtime.sessionStore.save({ ...session, workingDir: dir });
      const store = harness.runtime.taskStore;
      const original = store.create({
        sessionId: session.id,
        userMessage: "run the overnight report",
        origin: "http",
        maxAttempts: 1,
        maxSteps: 12,
        maxCostUsd: 5,
        maxDurationMs: 3_600_000,
        notify: "telegram",
      });
      store.markRunning(original.id);
      store.markBlocked(original.id, { category: "transport", message: "spend ceiling reached" });

      const refreshed = (await (await post("/api/ideas/refresh")).json()) as { ideas: IdeaJson[] };
      const idea = refreshed.ideas.find((i) => i.kind === "retry_task")!;
      expect(idea.sourceTaskId).toBe(original.id);

      const res = await post(`/api/ideas/${idea.id}/accept`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { task: { id: string; sessionId: string | null } };
      const task = store.get(body.task.id)!;
      expect(task).toMatchObject({
        maxSteps: 12,
        maxCostUsd: 5,
        maxDurationMs: 3_600_000,
        notify: "telegram",
      });
      // A fresh chat, not the original one, but in the original's folder.
      expect(task.sessionId).not.toBeNull();
      expect(task.sessionId).not.toBe(session.id);
      expect(harness.runtime.sessionStore.load(task.sessionId!)?.workingDir).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dismiss retires the idea for good", async () => {
    failedTask("tidy the inbox");
    const refreshed = (await (await post("/api/ideas/refresh")).json()) as { ideas: IdeaJson[] };
    const id = refreshed.ideas[0]!.id;
    const res = await post(`/api/ideas/${id}/dismiss`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { idea: IdeaJson }).idea.status).toBe("dismissed");
    const after = (await (await post("/api/ideas/refresh")).json()) as { ideas: IdeaJson[]; added: string[] };
    expect(after.added).toEqual([]);
    expect(after.ideas).toEqual([]);
  });

  it("answers 404 for an unknown idea and 400 for a bad status or prompt", async () => {
    expect((await post("/api/ideas/nope/accept")).status).toBe(404);
    expect((await post("/api/ideas/nope/dismiss")).status).toBe(404);
    expect((await fetch(`${harness.baseUrl}/api/ideas?status=done`)).status).toBe(400);
    failedTask("tidy the inbox");
    const refreshed = (await (await post("/api/ideas/refresh")).json()) as { ideas: IdeaJson[] };
    const bad = await post(`/api/ideas/${refreshed.ideas[0]!.id}/accept`, { prompt: 42 });
    expect(bad.status).toBe(400);
  });
});

/**
 * Issue #68: a Retry card never widens what the retried prompt may reach.
 * The new chat carries the original chat's restriction (its folder's
 * constraint and its read taint) as a read taint, wherever it opens; a
 * retry whose original chat is gone is refused while constraints exist.
 */
describe("/api/ideas accept keeps the original chat's restriction (issue #68)", () => {
  let harness: Harness | undefined;
  const dirs: string[] = [];
  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const post = (h: Harness, path: string) => fetch(`${h.baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" } });

  async function retryIdea(h: Harness, session: { id: string; workingDir: string; metadata?: Record<string, unknown> }): Promise<string> {
    h.runtime.sessionStore.save({ ...h.runtime.createSession({ persist: false }), ...session });
    const store = h.runtime.taskStore;
    const original = store.create({ sessionId: session.id, userMessage: "summarise the acme figures", origin: "http", maxAttempts: 1 });
    store.markRunning(original.id);
    store.markBlocked(original.id, { category: "transport", message: "spend ceiling reached" });
    const refreshed = (await (await post(h, "/api/ideas/refresh")).json()) as { ideas: IdeaJson[] };
    return refreshed.ideas.find((i) => i.kind === "retry_task")!.id;
  }

  it("a retry whose constrained folder is gone runs in a new chat that keeps the folder's restriction", async () => {
    const secret = mkdtempSync(join(tmpdir(), "idea-secret-"));
    dirs.push(secret);
    harness = await startTestHarness({ constraints: { [secret]: { allowedProviders: ["local-llama"] } } });
    const id = await retryIdea(harness, { id: "s-secret", workingDir: secret });
    rmSync(secret, { recursive: true, force: true });
    const res = await post(harness, `/api/ideas/${id}/accept`);
    expect(res.status).toBe(200);
    const task = harness.runtime.taskStore.get(((await res.json()) as { task: { id: string } }).task.id)!;
    expect(task.sessionId).not.toBeNull();
    expect(harness.runtime.egressRefusal?.(task.sessionId!, "web")).toContain("restricted");
    const fresh = harness.runtime.sessionStore.load(task.sessionId!)!;
    // The same folder `atomic-agent ideas accept` opens it in: the home folder.
    expect(fresh.workingDir).toBe(homedir());
    expect(harness.runtime.providerRestrictionFor?.(fresh)?.allowedProviders).toEqual(["local-llama"]);
  });

  it("a retry in the original's folder keeps the original chat's read taint", async () => {
    const open = mkdtempSync(join(tmpdir(), "idea-open-"));
    dirs.push(open);
    harness = await startTestHarness({ constraints: { "/work/secret": { allowedProviders: ["local-llama"] } } });
    const id = await retryIdea(harness, {
      id: "s-tainted", workingDir: open,
      metadata: { providerReadTaint: { key: "/work/secret", allowedProviders: ["local-llama"], allowedEgress: [], matchedDir: "/work/secret", readFrom: ["/work/secret"] } },
    });
    const res = await post(harness, `/api/ideas/${id}/accept`);
    expect(res.status).toBe(200);
    const task = harness.runtime.taskStore.get(((await res.json()) as { task: { id: string } }).task.id)!;
    expect(task.sessionId).not.toBe("s-tainted");
    expect(harness.runtime.sessionStore.load(task.sessionId!)?.workingDir).toBe(open);
    expect(harness.runtime.egressRefusal?.(task.sessionId!, "web")).toContain("restricted");
  });

  it("a retry whose chat was deleted after the card was offered keeps the restriction recorded on the card", async () => {
    const secret = mkdtempSync(join(tmpdir(), "idea-rec-"));
    dirs.push(secret);
    harness = await startTestHarness({ constraints: { [secret]: { allowedProviders: ["local-llama"] } } });
    const id = await retryIdea(harness, { id: "s-rec", workingDir: secret });
    harness.runtime.sessionStore.delete("s-rec");
    const res = await post(harness, `/api/ideas/${id}/accept`);
    expect(res.status).toBe(200);
    const task = harness.runtime.taskStore.get(((await res.json()) as { task: { id: string } }).task.id)!;
    expect(task.sessionId).not.toBeNull();
    expect(harness.runtime.egressRefusal?.(task.sessionId!, "web")).toContain("restricted");
    expect(harness.runtime.providerRestrictionFor?.(harness.runtime.sessionStore.load(task.sessionId!)!)?.allowedProviders).toEqual(["local-llama"]);
  });

  it("refuses, and retires, a retry whose chat was gone before its restriction could be recorded (fail closed)", async () => {
    harness = await startTestHarness({ constraints: { "/work/secret": { allowedProviders: ["local-llama"] } } });
    const h = harness;
    h.runtime.sessionStore.save({ ...h.runtime.createSession({ persist: false }), id: "s-gone", workingDir: h.workingDir });
    const original = h.runtime.taskStore.create({ sessionId: "s-gone", userMessage: "summarise the acme figures", origin: "http", maxAttempts: 1 });
    h.runtime.taskStore.markRunning(original.id);
    h.runtime.taskStore.markBlocked(original.id, { category: "transport", message: "spend ceiling reached" });
    h.runtime.sessionStore.delete("s-gone");
    const refreshed = (await (await post(h, "/api/ideas/refresh")).json()) as { ideas: IdeaJson[] };
    const id = refreshed.ideas.find((i) => i.kind === "retry_task")!.id;
    const before = h.runtime.taskStore.list({ limit: 50 }).length;
    const res = await post(h, `/api/ideas/${id}/accept`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("restriction");
    expect(h.runtime.taskStore.list({ limit: 50 })).toHaveLength(before);
    // The card does not come back to loop on the same refusal.
    const waiting = (await (await fetch(`${h.baseUrl}/api/ideas?status=new`)).json()) as { ideas: IdeaJson[] };
    expect(waiting.ideas.map((i) => i.id)).not.toContain(id);
    const again = (await (await post(h, "/api/ideas/refresh")).json()) as { ideas: IdeaJson[] };
    expect(again.ideas.map((i) => i.id)).not.toContain(id);
  });

  it("an unrestricted original changes nothing: a plain chat in its folder", async () => {
    const open = mkdtempSync(join(tmpdir(), "idea-plain-"));
    dirs.push(open);
    harness = await startTestHarness({ constraints: { "/work/secret": { allowedProviders: ["local-llama"] } } });
    const id = await retryIdea(harness, { id: "s-plain", workingDir: open });
    const res = await post(harness, `/api/ideas/${id}/accept`);
    expect(res.status).toBe(200);
    const task = harness.runtime.taskStore.get(((await res.json()) as { task: { id: string } }).task.id)!;
    const fresh = harness.runtime.sessionStore.load(task.sessionId!)!;
    expect(fresh.workingDir).toBe(open);
    expect(fresh.metadata?.providerReadTaint).toBeUndefined();
    expect(harness.runtime.egressRefusal?.(task.sessionId!, "web")).toBeNull();
  });
});
