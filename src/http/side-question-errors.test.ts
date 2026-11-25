import { afterEach, expect, it, vi } from "vitest";
import { hashHttpToken } from "./http-token-store.js";
import { startTestHarness, type Harness } from "./test-harness.js";

let h: Harness | undefined;
afterEach(async () => { await h?.cleanup(); h = undefined; vi.restoreAllMocks(); });
const owner = "btw-owner-fixture";
const named = "btw-named-fixture";
const post = async (token: string | undefined, body: unknown) => {
  const response = await fetch(h!.baseUrl + "/api/btw", {
    method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
};

it("replaces provider failures with a fixed 502 message for named callers", async () => {
  h = await startTestHarness({ apiKey: owner, namedTokens: () => [{ name: "fixture", role: "member", sha256: hashHttpToken(named), createdAt: "" }] });
  vi.spyOn(h.runtime, "askSideQuestion").mockResolvedValue({ ok: false, reason: "provider failed with SYNTHETIC-SECRET in chat private-id" });
  const response = await post(named, { question: "hello" });
  expect(response.status).toBe(502);
  expect(JSON.parse(response.text).error.message).toBe("The model could not answer the side question");
  expect(response.text).not.toContain("SYNTHETIC-SECRET");
  expect((await post(owner, { question: "hello" })).text).toContain("SYNTHETIC-SECRET");
});
