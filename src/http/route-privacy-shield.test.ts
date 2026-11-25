import { afterEach, describe, expect, it, vi } from "vitest";

import { getConfig, resetConfigCache } from "../config/index.js";
import { privacyVaultFor, resetPrivacyVaults } from "../privacy/index.js";
import { fixtureProjectGateView } from "../session/project-gate-view-fixtures.js";
import { hashHttpToken } from "./http-token-store.js";
import { startTestHarness, type Harness } from "./test-harness.js";

interface ShieldJson {
  enabled: boolean;
  masked: number;
  sessions: number;
  session?: { masked: number; lastRequest: number };
}

async function get(baseUrl: string, query = ""): Promise<{ status: number; json: ShieldJson }> {
  const res = await fetch(`${baseUrl}/api/privacy-shield${query}`);
  return { status: res.status, json: (await res.json()) as ShieldJson };
}

async function post(baseUrl: string, body: unknown): Promise<{ status: number; json: ShieldJson }> {
  const res = await fetch(`${baseUrl}/api/privacy-shield`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as ShieldJson };
}

describe("GET/POST /api/privacy-shield (ATO-1082)", () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = null;
    resetPrivacyVaults();
  });

  it("is off by default and counts nothing", async () => {
    harness = await startTestHarness();
    const first = await get(harness.baseUrl);
    expect(first.status).toBe(200);
    expect(first.json).toEqual({ enabled: false, masked: 0, sessions: 0 });
  });

  it("turns on, persists the key and reports masked counts", async () => {
    harness = await startTestHarness();
    const posted = await post(harness.baseUrl, { enabled: true });
    expect(posted.status).toBe(200);
    expect(posted.json.enabled).toBe(true);
    resetConfigCache();
    expect(getConfig().privacy?.shield.enabled).toBe(true);

    privacyVaultFor("s-1").mask("mail a@b.io");
    const read = await get(harness.baseUrl, "?sessionId=s-1");
    expect(read.json).toMatchObject({ enabled: true, masked: 1, sessions: 1, session: { masked: 1 } });

    const off = await post(harness.baseUrl, { enabled: false });
    expect(off.json.enabled).toBe(false);
  });

  it("lets a viewer read counts and only an admin change the switch", async () => {
    const viewer = "atag_viewer-token-000000000000000";
    const admin = "atag_admin-token-0000000000000000";
    harness = await startTestHarness({
      apiKey: "k".repeat(32),
      namedTokens: () => (["viewer", "admin"] as const).map(role => ({
        name: role, role, sha256: hashHttpToken(role === "viewer" ? viewer : admin), createdAt: new Date().toISOString(),
      })),
    });
    const privateValue = "private@example.test";
    privacyVaultFor("s-1").mask(privateValue);
    const url = harness.baseUrl + "/api/privacy-shield?sessionId=s-1";
    const read = await fetch(url, { headers: { authorization: "Bearer " + viewer } });
    expect(read.status).toBe(200);
    const text = await read.text();
    expect(text).not.toContain(privateValue);
    expect(text).not.toContain("[EMAIL_1]");
    expect(JSON.parse(text)).toMatchObject({ enabled: false, masked: 1, sessions: 1 });
    for (const method of ["POST", "PATCH"]) {
      const change = (token: string, enabled: boolean) => fetch(url, {
        method,
        headers: { authorization: "Bearer " + token, "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      expect((await change(viewer, true)).status).toBe(403);
      expect((await change(admin, true)).status).toBe(200);
      const updated = await change(admin, false);
      expect(updated.status).toBe(200);
      expect(await updated.json()).toMatchObject({ enabled: false });
    }
  });

  it.each(["viewer", "member", "operator", "admin"] as const)("hides unavailable chats on both read routes from %s", async (role) => {
    const token = "atag_viewer-token-000000000000000";
    harness = await startTestHarness({
      apiKey: "k".repeat(32),
      namedTokens: () => [{ name: "reader", role, sha256: hashHttpToken(token), createdAt: new Date().toISOString() }],
    });
    const chat = harness.runtime.createSession({ incognito: true });
    privacyVaultFor(chat.id).mask("private@example.test");
    const read = (id: string) => fetch(harness!.baseUrl + "/api/privacy-shield?sessionId=" + id, {
      headers: { authorization: "Bearer " + token },
    });
    const [unavailable, absent] = await Promise.all([read(chat.id), read("unknown")]);
    expect(unavailable.status).toBe(absent.status);
    expect(await unavailable.json()).toEqual(await absent.json());
    const readChat = (id: string) => fetch(harness!.baseUrl + "/api/sessions/" + id, {
      headers: { authorization: "Bearer " + token },
    });
    const [hiddenChat, missingChat] = await Promise.all([readChat(chat.id), readChat("unknown")]);
    expect(hiddenChat.status).toBe(404);
    expect(await hiddenChat.json()).toEqual(await missingChat.json());
    const request = (method: string, path: string, body: unknown) => fetch(harness!.baseUrl + path, {
      method, headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const attempts = [
      ["PATCH", "", { title: "fixture title" }],
      ["POST", "/archived", { archived: true }],
      ["POST", "/steer", { message: "fixture" }],
      ["POST", "/fork", {}],
      ["POST", "/rewind/preview", {}],
    ] as const;
    for (const [method, suffix, body] of attempts) {
      const hidden = await request(method, "/api/sessions/" + chat.id + suffix, body);
      const missing = await request(method, "/api/sessions/unknown" + suffix, body);
      expect(hidden.status).toBe(role === "viewer" ? 403 : 404);
      expect(await hidden.json()).toEqual(await missing.json());
    }
    const complete = (id: string) => request("POST", "/v1/chat/completions", {
      model: "atomic-agent", session_id: id, messages: [{ role: "user", content: "fixture" }],
    });
    const hiddenTurn = await complete(chat.id);
    const missingTurn = await complete("unknown");
    expect(hiddenTurn.status).toBe(role === "viewer" ? 403 : 404);
    expect(await hiddenTurn.json()).toEqual(await missingTurn.json());


  });

  it.each(["viewer", "member", "operator", "admin"] as const)("omits private approvals and gates from %s event streams", async (role) => {
    const token = "atag_fixture-event-token-00000000000000";
    harness = await startTestHarness({
      apiKey: "k".repeat(32),
      namedTokens: () => [{ name: "reader", role, sha256: hashHttpToken(token), createdAt: "" }],
    });
    const hidden = harness.runtime.createSession({ incognito: true });
    const visible = harness.runtime.createSession();
    vi.spyOn(harness.runtime.approvals, "isPending").mockReturnValue(true);
    const approvals = harness.approvalBus;
    const publish = (sessionId: string, approvalId: string) => approvals.publish({
      approvalId, sessionId, tool: "os.shell.run", category: "shell", reason: "fixture",
    });
    publish(hidden.id, "private-replay");
    const gates = harness.handle.projectGateBus;
    const view = fixtureProjectGateView({ kind: "plan" });
    gates.publish({ type: "project_gate", sessionId: hidden.id, view });
    const stream = await fetch(harness.baseUrl + "/api/events", {
      headers: { authorization: "Bearer " + token }, signal: AbortSignal.timeout(4000),
    });
    const reader = stream.body!.getReader();
    try {
      publish(hidden.id, "private-live");
      gates.publish({ type: "project_gate", sessionId: hidden.id, view });
      publish(visible.id, "visible-approval");
      const decoder = new TextDecoder();
      let events = "";
      while (!events.includes("visible-approval")) {
        const item = await reader.read();
        if (item.done) break;
        events += decoder.decode(item.value, { stream: true });
      }
      expect(events).toContain("visible-approval");
      expect(events).not.toContain(hidden.id);
      expect(events).not.toContain("private-replay");
      expect(events).not.toContain("private-live");
    } finally {
      await reader.cancel().catch(() => {});
      vi.restoreAllMocks();
    }
  });

  it("refuses named incognito creation before running a turn", async () => {
    const token = "fixture-member";
    harness = await startTestHarness({ apiKey: "k".repeat(32), namedTokens: () => [
      { name: "member", role: "member", sha256: hashHttpToken(token), createdAt: "" },
    ] });
    const turn = vi.spyOn(harness.runtime, "runTurn");
    const response = await fetch(harness.baseUrl + "/v1/chat/completions", {
      method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ model: "atomic-agent", incognito: true, messages: [{ role: "user", content: "fixture" }] }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "incognito_owner_only" } });
    expect(turn).not.toHaveBeenCalled();
  });

  it("refuses a body without a boolean", async () => {
    harness = await startTestHarness();
    const bad = await post(harness.baseUrl, { enabled: "yes" });
    expect(bad.status).toBe(400);
  });
});
