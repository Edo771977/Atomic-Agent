import { seedLegacyRetry } from "../tasks/idea-legacy-fixture.js";
import { IdeaStore } from "../tasks/idea-store.js";
import { afterEach, expect, it, vi } from "vitest";
import { hashHttpToken } from "./http-token-store.js";
import { startTestHarness, type Harness } from "./test-harness.js";

let harness: Harness | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await harness?.cleanup();
  harness = undefined;
});

async function fixture(role: "viewer" | "member" | "operator" | "admin") {
  const token = "visibility-fixture";
  const h = await startTestHarness({
    apiKey: "owner-fixture",
    webhooks: {
      "private-binding": { sessionMode: "persistent", userMessageTemplate: "fixture" },
      "unknown-binding": { sessionMode: "persistent", userMessageTemplate: "fixture" },
    },
    namedTokens: () => [{ name: "fixture", role, sha256: hashHttpToken(token), createdAt: "" }],
  });
  harness = h;
  const hidden = h.runtime.createSession({ incognito: true });
  const visible = h.runtime.createSession();
  h.runtime.webhookSessionStore.set("private-binding", hidden.id);
  h.runtime.webhookSessionStore.set("unknown-binding", "unknown-session");
  const call = async (method: string, path: string, body?: object) => {
    const res = await fetch(h.baseUrl + path, {
      method, headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.json() };
  };
  return { h, hidden, visible, call };
}

it.each(["viewer", "member", "operator", "admin"] as const)("hides tasks bound to private sessions from %s", async (role) => {
  const { h, hidden, visible, call } = await fixture(role);
  const makeTask = (sessionId: string) => h.runtime.taskStore.create({ sessionId, userMessage: "fixture", origin: "cli", maxAttempts: 1 });
  const secret = makeTask(hidden.id);
  const ordinary = makeTask(visible.id);
  expect(secret.incognito).toBe(true);
  const check = async () => {
    const list = await call("GET", "/api/tasks");
    expect(list.body).toMatchObject({ tasks: [expect.objectContaining({ id: ordinary.id })] });
    for (const [method, suffix] of [["GET", ""], ["GET", "/runs"], ["POST", "/run"], ["POST", "/pause"], ["POST", "/resume"], ["DELETE", ""]]) {
      const actual = await call(method!, "/api/tasks/" + secret.id + suffix);
      const unknown = await call(method!, "/api/tasks/unknown-task" + suffix);
      expect(actual.status).toBe(method === "GET" || role === "admin" ? 404 : 403);
      expect(actual).toEqual(unknown);
    }
  };
  const create = (sessionId: string) => call("POST", "/api/tasks", { sessionId, userMessage: "fixture", notify: "push" });
  expect(await create(hidden.id)).toEqual(await create("unknown-session"));
  await check();
  h.runtime.sessionStore.delete(hidden.id);
  await check();
});

it("makes private and unknown IDs indistinguishable on auxiliary routes for members", async () => {
  const { h, hidden, call } = await fixture("member");
  h.handle.completionRegistry.register({ completionId: hidden.id, sessionId: hidden.id, controller: new AbortController(), startedAt: 0 });
  const cases: Array<(id: string) => Promise<unknown>> = [
    (id) => call("POST", "/api/context-preview", { session_id: id, message: "fixture" }),
    (id) => call("POST", "/v1/chat/completions/" + id + "/cancel"),
    (id) => call("GET", "/api/project?session=" + id),
    (id) => call("GET", "/api/project/lessons?session=" + id),
    (id) => call("GET", "/api/fusion/team?session=" + id),
    (id) => call("POST", "/api/approval/resolve", { approvalId: id, decision: "deny" }),
    (id) => call("POST", "/api/question/answer", { approvalId: id, skip: true }),
  ];
  for (const invoke of cases) {
    expect(await invoke(hidden.id)).toEqual(await invoke("unknown-session"));
  }
  expect((await call("POST", "/api/webhooks/private-binding", {})).status).toBe(404);
  expect((await call("POST", "/api/webhooks/unknown-binding", {})).status).toBe(202);
  expect(h.handle.completionRegistry.has(hidden.id)).toBe(true);
});

it("keeps hidden approval and question records unreachable by an operator", async () => {
  const { h, hidden, call } = await fixture("operator");
  vi.spyOn(h.runtime.approvals, "pendingRequest").mockImplementation((id) => id === "private-approval"
    ? { approvalId: id, sessionId: hidden.id, category: "shell", tool: "os.shell.run", reason: "fixture" }
    : null);
  const resolve = vi.spyOn(h.runtime.approvals, "resolve");
  for (const [path, body] of [["/api/approval/resolve", { decision: "allow-once" }], ["/api/question/answer", { skip: true }]] as const) {
    const hiddenResponse = await call("POST", path, { ...body, approvalId: "private-approval" });
    const unknown = await call("POST", path, { ...body, approvalId: "unknown-approval" });
    expect(hiddenResponse.status).toBe(404);
    expect(hiddenResponse).toEqual(unknown);
  }
  expect(resolve).not.toHaveBeenCalledWith(expect.objectContaining({ approvalId: "private-approval" }));
});

it("keeps hidden task runs out of the named admin drain", async () => {
  const { h, hidden, visible, call } = await fixture("admin");
  const makeTask = (sessionId: string) => h.runtime.taskStore.create({ sessionId, userMessage: "fixture", origin: "cli", maxAttempts: 1 });
  const privateTask = makeTask(hidden.id);
  const publicTask = makeTask(visible.id);
  const runOne = vi.spyOn(h.runtime.taskRunner, "runOne").mockImplementation(async (id) => {
    const task = h.runtime.taskStore.get(id);
    return task ? { ...task, status: "completed" } : null;
  });
  expect((await call("POST", "/api/tasks/drain")).status).toBe(200);
  expect(runOne).toHaveBeenCalledWith(publicTask.id, undefined);
  expect(runOne).not.toHaveBeenCalledWith(privateTask.id, undefined);
});


it("lets a named admin manage an ordinary recurring task after its chat is deleted", async () => {
  const { h, hidden, visible, call } = await fixture("admin");
  const makeTask = (sessionId: string) => h.runtime.taskStore.create({
    sessionId, userMessage: "fixture", origin: "cli", maxAttempts: 1,
    schedule: { kind: "interval", everyMs: 60_000 },
  });
  const ordinary = makeTask(visible.id);
  const secret = makeTask(hidden.id);
  h.runtime.sessionStore.delete(visible.id);
  h.runtime.sessionStore.delete(hidden.id);
  expect((await call("GET", "/api/tasks")).body).toMatchObject({ tasks: [expect.objectContaining({ id: ordinary.id })] });
  expect((await call("GET", "/api/tasks?session=" + visible.id)).body).toMatchObject({ tasks: [{ id: ordinary.id }] });
  expect((await call("GET", "/api/tasks/" + ordinary.id)).status).toBe(200);
  expect((await call("POST", "/api/tasks/" + ordinary.id + "/pause")).status).toBe(200);
  expect((await call("DELETE", "/api/tasks/" + ordinary.id)).status).toBe(200);
  for (const [method, suffix] of [["GET", ""], ["POST", "/pause"], ["DELETE", ""]]) {
    expect((await call(method!, "/api/tasks/" + secret.id + suffix)).status).toBe(404);
  }
  expect((await call("POST", "/api/tasks", { sessionId: "not-created", userMessage: "fixture" })).status).toBe(404);
});

it("shows retry ideas for ordinary tasks whose chat is gone", async () => {
  const { h, visible, call } = await fixture("admin");
  const task = h.runtime.taskStore.create({ sessionId: visible.id, userMessage: "retry fixture", origin: "cli", maxAttempts: 1 });
  h.runtime.taskStore.markRunning(task.id);
  h.runtime.taskStore.markFailed(task.id, { category: "transport", message: "timed out" });
  h.runtime.sessionStore.delete(visible.id);
  expect((await call("POST", "/api/ideas/refresh")).body).toMatchObject({ ideas: [expect.objectContaining({ sourceTaskId: task.id })] });
  expect((await call("GET", "/api/ideas")).body).toMatchObject({ ideas: [expect.objectContaining({ sourceTaskId: task.id })] });
});


it.each([
  ["/api/approval/resolve", { decision: "deny" }],
  ["/api/question/answer", { skip: true }],
] as const)("clears stale mirrored cards for a named operator on %s", async (path, body) => {
  const { h, visible, hidden, call } = await fixture("operator");
  const pending = { approvalId: "stale-card", sessionId: visible.id, category: "shell" as const, tool: "os.shell.run", reason: "fixture" };
  const privatePending = { ...pending, approvalId: "private-card", sessionId: hidden.id };
  h.approvalBus.publish(pending);
  h.approvalBus.publish(privatePending);
  vi.spyOn(h.runtime.approvals, "pendingRequest").mockImplementation((id) => id === privatePending.approvalId ? privatePending : null);
  expect((await call("POST", path, { ...body, approvalId: pending.approvalId })).status).toBe(404);
  expect(h.approvalBus.snapshot()).toEqual([privatePending]);
  expect((await call("POST", path, { ...body, approvalId: privatePending.approvalId })).status).toBe(404);
  expect(h.approvalBus.snapshot()).toEqual([privatePending]);
});


it("never exposes or replays private Retry ideas after the owner closes the chat", async () => {
  const { h, hidden, call } = await fixture("admin");
  const task = h.runtime.taskStore.create({ sessionId: hidden.id, userMessage: "PRIVATE-TASK-SECRET", origin: "cli", maxAttempts: 1 });
  h.runtime.taskStore.markRunning(task.id);
  h.runtime.taskStore.markFailed(task.id, { category: "transport", message: "private error" });
  const refresh = await fetch(h.baseUrl + "/api/ideas/refresh", {
    method: "POST", headers: { authorization: "Bearer owner-fixture", "content-type": "application/json" }, body: "{}",
  });
  expect(await refresh.json()).toMatchObject({ ideas: [] });
  const ideas = new IdeaStore({ dbFile: h.runtime.config.paths.tasksDbFile });
  let id: string;
  try {
    id = seedLegacyRetry(h.runtime.config.paths.tasksDbFile, { kind: "retry_task", sourceKey: "task:" + task.id, title: "private", reason: "fixture",
      evidence: { source: "task", ref: task.id, excerpt: "private", at: null }, prompt: "PRIVATE-TASK-SECRET", sessionId: null });
  } finally { ideas.close(); }
  const deleted = await fetch(h.baseUrl + "/api/sessions/" + hidden.id, { method: "DELETE", headers: { authorization: "Bearer owner-fixture" } });
  expect(deleted.status).toBe(200);
  expect((await call("GET", "/api/ideas")).body).toMatchObject({ ideas: [] });
  expect((await call("POST", "/api/ideas/" + id + "/accept", {})).status).toBe(404);
  expect(h.runtime.taskStore.list()).toEqual([]);
});
