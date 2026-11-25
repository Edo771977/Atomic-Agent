import { afterEach, expect, it, vi } from "vitest";
import { hashHttpToken } from "./http-token-store.js";
import { scopeForRoute } from "./http-scopes.js";
import { startTestHarness, type Harness } from "./test-harness.js";
import { OpenAiProvider } from "../llm/provider/openai/openai-provider.js";
import { egressSnapshot, setOfflineNetwork } from "../llm/offline-network.js";
import { privacyShieldSessionStats, resetPrivacyVaults } from "../privacy/index.js";

let h: Harness | undefined;
afterEach(async () => { await h?.cleanup(); h = undefined; setOfflineNetwork(false); resetPrivacyVaults(); vi.restoreAllMocks(); });
const owner = "btw-owner-fixture";
const named = "btw-named-fixture";
const datedServers = new WeakSet<object>();
const post = async (token: string | undefined, body: unknown) => {
  // Pin the protocol clock, so every header can be compared across requests.
  if (!datedServers.has(h!.handle.server)) {
    h!.handle.server.prependListener("request", (_req, res) => res.setHeader("date", "Wed, 25 Nov 2026 00:00:00 GMT"));
    datedServers.add(h!.handle.server);
  }
  const response = await fetch(h!.baseUrl + "/api/btw", {
    method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const contentLength = response.headers.get("content-length");
  expect(contentLength).toBe(String(Buffer.byteLength(text)));
  return { status: response.status, text, headers: Object.fromEntries([...response.headers].sort()), contentLength };
};

it.each(["viewer", "member", "operator", "admin"] as const)("enforces the chat scope and key on btw for %s", async role => {
  h = await startTestHarness({ apiKey: owner, namedTokens: () => [{ name: "fixture", role, sha256: hashHttpToken(named), createdAt: "" }] });
  const ask = vi.spyOn(h.runtime, "askSideQuestion").mockResolvedValue({ ok: true, text: "fixture" });
  expect(scopeForRoute("POST", "/api/btw")).toBe("chat");
  expect((await post(undefined, { question: "hello" })).status).toBe(401);
  expect((await post(named, { question: "hello" })).status).toBe(role === "viewer" ? 403 : 200);
  expect(ask).toHaveBeenCalledTimes(role === "viewer" ? 0 : 1);
});

it.each(["member", "operator", "admin"] as const)("makes incognito and unknown sessions byte-identical for %s", async role => {
  h = await startTestHarness({ apiKey: owner, namedTokens: () => [{ name: "fixture", role, sha256: hashHttpToken(named), createdAt: "" }] });
  const session = h.runtime.createSession({ incognito: true });
  const ask = vi.spyOn(h.runtime, "askSideQuestion").mockResolvedValue({ ok: true, text: "private" });
  const unknown = await post(named, { question: "hello", session_id: "unknown-session" });
  expect(unknown.status).toBe(404);
  expect(unknown).toHaveProperty("headers");
  expect(unknown).toHaveProperty("contentLength");
  expect(await post(named, { question: "hello", session_id: session.id })).toEqual(unknown);
  expect(ask).not.toHaveBeenCalled();
  expect((await post(owner, { question: "hello", session_id: session.id })).status).toBe(200);
});

it("withholds network-restricted session context and response, also for the owner", async () => {
  h = await startTestHarness({ apiKey: owner, host: "0.0.0.0", constraints: { "<cwd>": { allowedProviders: ["local"], allowedEgress: [] } } });
  const session = h.runtime.createSession();
  const ask = vi.spyOn(h.runtime, "askSideQuestion").mockResolvedValue({ ok: true, text: "restricted" });
  expect((await post(owner, { question: "hello", session_id: session.id })).status).toBe(403);
  expect(ask).not.toHaveBeenCalled();
});

it.each(["viewer", "member", "operator", "admin"] as const)("makes a folder-withheld chat byte-identical to an unknown ID for %s", async role => {
  h = await startTestHarness({ apiKey: owner, host: "0.0.0.0", constraints: { "<cwd>": { allowedProviders: ["local"], allowedEgress: [] } },
    namedTokens: () => [{ name: "fixture", role, sha256: hashHttpToken(named), createdAt: "" }],
  });
  const session = h.runtime.createSession();
  const ask = vi.spyOn(h.runtime, "askSideQuestion").mockResolvedValue({ ok: true, text: "restricted" });
  const unknown = await post(named, { question: "hello", session_id: "unknown-session" });
  expect(unknown.status).toBe(role === "viewer" ? 403 : 404);
  expect(await post(named, { question: "hello", session_id: session.id })).toEqual(unknown);
  expect(ask).not.toHaveBeenCalled();
});

it.each(["../secret", "a/b", ".hidden", "x\\y", "x\u0000y", "x".repeat(257)])("validates supplied session IDs before runtime: %s", async session_id => {
  h = await startTestHarness({ apiKey: owner });
  const ask = vi.spyOn(h.runtime, "askSideQuestion").mockResolvedValue({ ok: true, text: "bad" });
  expect((await post(owner, { question: "hello", session_id })).status).toBe(400);
  expect(ask).not.toHaveBeenCalled();
});

it("drops an answer when a concurrent turn makes its chat inaccessible", async () => {
  h = await startTestHarness({ apiKey: owner, namedTokens: () => [{ name: "fixture", role: "member", sha256: hashHttpToken(named), createdAt: "" }] });
  const session = h.runtime.createSession();
  vi.spyOn(h.runtime, "askSideQuestion").mockImplementation(async () => {
    h!.runtime.sessionStore.delete(session.id);
    return { ok: true, text: "DO-NOT-EXPOSE" };
  });
  const response = await post(named, { question: "hello", session_id: session.id });
  expect(response.status).toBe(404);
  expect(response.text).not.toContain("DO-NOT-EXPOSE");
});

it.each([false, true])("preserves the owner's folder restriction after inference, with session=%s", async withSession => {
  h = await startTestHarness({ apiKey: owner, host: "0.0.0.0", constraints: { "<cwd>": { allowedProviders: ["local"], allowedEgress: [] } } });
  const id = withSession ? h.runtime.createSession().id : undefined;
  let restricted = false;
  vi.spyOn(h.runtime, "serveRefusal").mockImplementation(() => restricted ? "restricted" : null);
  vi.spyOn(h.runtime, "askSideQuestion").mockImplementation(async () => { restricted = true; return { ok: true, text: "PRIVATE" }; });
  const body = { question: "hello", session_id: id };
  const after = await post(owner, body);
  expect(after.status).toBe(403);
  expect(JSON.parse(after.text).error.code).toBe("folder_restricted");
  expect(after).toEqual(await post(owner, body));
});

it("keeps a named draft restriction at 403, without inventing an unknown session", async () => {
  h = await startTestHarness({ apiKey: owner, host: "0.0.0.0", constraints: { "<cwd>": { allowedProviders: ["local"], allowedEgress: [] } }, namedTokens: () => [{ name: "fixture", role: "member", sha256: hashHttpToken(named), createdAt: "" }] });
  let restricted = false;
  vi.spyOn(h.runtime, "serveRefusal").mockImplementation(() => restricted ? "restricted" : null);
  vi.spyOn(h.runtime, "askSideQuestion").mockImplementation(async () => { restricted = true; return { ok: true, text: "PRIVATE" }; });
  const response = await post(named, { question: "hello" });
  expect(response.status).toBe(403);
  expect(JSON.parse(response.text).error.code).toBe("folder_restricted");
});

it("masks private side-question text at the covered cloud provider boundary", async () => {
  let wire = "";
  const cloud = new OpenAiProvider({ id: "cloud", baseUrl: "https://cloud.example.invalid", apiKey: "", defaultChatModel: "fixture", privacy: { shield: "on" },
    fetchImpl: (async (_url, init) => {
      wire = String(init?.body);
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  h = await startTestHarness({ apiKey: owner, llamaComplete: params => cloud.complete(params) });
  const session = h.runtime.createSession({ incognito: true });
  const response = await post(owner, { question: "What about jane.doe@example.com?", session_id: session.id });
  expect(response.status, response.text).toBe(200);
  expect(wire).toContain("[EMAIL_1]");
  expect(wire).not.toContain("jane.doe@example.com");
  expect(privacyShieldSessionStats(`btw:${session.id}`)).toEqual({ masked: 0, lastRequest: 0 });
});

it("refuses cloud egress for a side question while offline", async () => {
  const cloud = new OpenAiProvider({ id: "cloud", baseUrl: "https://cloud.example.invalid", apiKey: "", defaultChatModel: "fixture" });
  h = await startTestHarness({ apiKey: owner, llamaComplete: params => cloud.complete(params) });
  setOfflineNetwork(true);
  const response = await post(owner, { question: "hello" });
  expect(response.status).toBe(502);
  expect(egressSnapshot()).toMatchObject({ bytesOut: 0, requestsOut: 0 });
  expect(egressSnapshot().requestsBlocked).toBeGreaterThan(0);
});

