import { afterEach, describe, expect, it } from "vitest";
import { OpenAiProvider } from "../llm/provider/openai/openai-provider.js";
import { resetPrivacyVaults, privacyShieldSessionStats } from "../privacy/index.js";
import { hashHttpToken } from "./http-token-store.js";
import { startTestHarness, type Harness } from "./test-harness.js";

const OWNER = "btw-isolation-owner";
const MEMBER = "btw-isolation-member";
const SECOND = "btw-isolation-second-member";
const PRIVATE = "synthetic.owner@example.test";
let h: Harness | undefined;
afterEach(async () => { await h?.cleanup(); h = undefined; resetPrivacyVaults(); });

describe.each([false, true])("side-question isolation with chat=%s", withChat => {
  it.each([[OWNER, MEMBER], [MEMBER, OWNER], [MEMBER, SECOND]])("isolates overlapping calls from %s and %s", async (seed, probe) => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const cloud = new OpenAiProvider({ id: "cloud", baseUrl: "https://synthetic.example.invalid", apiKey: "", defaultChatModel: "fixture", privacy: { shield: "on" },
      fetchImpl: (async (_url, init) => {
        const wire = String(init?.body);
        expect(wire).not.toContain(PRIVATE);
        if (wire.includes("SEED")) { expect(wire).toContain("[EMAIL_1]"); entered(); await hold; }
        return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "[EMAIL_1]" }, finish_reason: "stop" }] }), { headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });
    h = await startTestHarness({ apiKey: OWNER, namedTokens: () => [MEMBER, SECOND].map((token, index) => ({ name: `member-${index}`, role: "member" as const, sha256: hashHttpToken(token), createdAt: "" })), llamaComplete: params => cloud.complete(params) });
    const sessionId = withChat ? h.runtime.createSession().id : undefined;
    const post = async (token: string, question: string) => {
      const response = await fetch(h!.baseUrl + "/api/btw", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ question, session_id: sessionId }) });
      expect(response.status).toBe(200);
      return await response.json() as { text: string };
    };
    const first = post(seed!, "SEED " + PRIVATE);
    await started;
    try { expect((await post(probe!, "PROBE literal [EMAIL_1]")).text).toBe("[EMAIL_1]"); }
    finally { release(); expect((await first).text).toBe(PRIVATE); }
    expect(privacyShieldSessionStats(`btw:${sessionId ?? "draft"}`)).toEqual({ masked: 0, lastRequest: 0 });
  });
});
