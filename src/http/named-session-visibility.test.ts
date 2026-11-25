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
  expect(await call("POST", "/api/webhooks/private-binding", {})).toEqual(
    await call("POST", "/api/webhooks/unknown-binding", {}),
  );
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
