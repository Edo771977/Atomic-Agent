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
    namedTokens: () => [{ name: "fixture", role, sha256: hashHttpToken(token), createdAt: "" }],
  });
  harness = h;
  const hidden = h.runtime.createSession({ incognito: true });
  const visible = h.runtime.createSession();
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
  const create = (sessionId: string) => call("POST", "/api/tasks", { sessionId, userMessage: "fixture" });
  expect(await create(hidden.id)).toEqual(await create("unknown-session"));
  await check();
  h.runtime.sessionStore.delete(hidden.id);
  await check();
});
