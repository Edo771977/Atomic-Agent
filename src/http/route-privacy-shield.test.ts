import { afterEach, describe, expect, it } from "vitest";

import { getConfig, resetConfigCache } from "../config/index.js";
import { privacyVaultFor, resetPrivacyVaults } from "../privacy/index.js";
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

  it("gives viewers the same response for an unavailable chat and an unknown ID", async () => {
    const token = "atag_viewer-token-000000000000000";
    harness = await startTestHarness({
      apiKey: "k".repeat(32),
      namedTokens: () => [{ name: "reader", role: "viewer", sha256: hashHttpToken(token), createdAt: new Date().toISOString() }],
    });
    const chat = harness.runtime.createSession({ incognito: true });
    privacyVaultFor(chat.id).mask("private@example.test");
    const read = (id: string) => fetch(harness!.baseUrl + "/api/privacy-shield?sessionId=" + id, {
      headers: { authorization: "Bearer " + token },
    });
    const [unavailable, absent] = await Promise.all([read(chat.id), read("unknown")]);
    expect(unavailable.status).toBe(absent.status);
    expect(await unavailable.json()).toEqual(await absent.json());
  });

  it("refuses a body without a boolean", async () => {
    harness = await startTestHarness();
    const bad = await post(harness.baseUrl, { enabled: "yes" });
    expect(bad.status).toBe(400);
  });
});
