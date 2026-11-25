import { afterEach, expect, it } from "vitest";
import { OpenAiProvider } from "../llm/provider/openai/openai-provider.js";
import { resetPrivacyVaults, privacyShieldSessionStats } from "../privacy/index.js";
import { hashHttpToken } from "./http-token-store.js";
import { startTestHarness, type Harness } from "./test-harness.js";

const OWNER = "complete-isolation-owner";
const MEMBER = "complete-isolation-member";
const SECOND = "complete-isolation-second-member";
const PRIVATE = "synthetic.owner@example.test";
let h: Harness | undefined;
afterEach(async () => { await h?.cleanup(); h = undefined; resetPrivacyVaults(); });

const pairs = [[OWNER, MEMBER], [MEMBER, OWNER], [MEMBER, SECOND]] as const;
const post = async (token: string, prompt: string) => {
  const response = await fetch(h!.baseUrl + "/api/complete", { method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ prompt }),
  });
  expect(response.status).toBe(200);
  return await response.json() as { text: string };
};

it.each(pairs)("isolates sequential complete requests from %s to %s", async (seed, probe) => {
  const cloud = provider(async () => {});
  h = await harness(cloud);
  expect((await post(seed, "SEED " + PRIVATE)).text).toBe(PRIVATE);
  expect((await post(probe, "PROBE literal [EMAIL_1]")).text).toBe("[EMAIL_1]");
  expect(privacyShieldSessionStats("complete:api")).toEqual({ masked: 0, lastRequest: 0 });
});

it.each(pairs)("isolates overlapping complete requests from %s and %s", async (seed, probe) => {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  const cloud = provider(async () => { entered(); await hold; });
  h = await harness(cloud);
  const first = post(seed, "SEED " + PRIVATE);
  await started;
  try { expect((await post(probe, "PROBE literal [EMAIL_1]")).text).toBe("[EMAIL_1]"); }
  finally { release(); expect((await first).text).toBe(PRIVATE); }
});

function provider(wait: () => Promise<void>) {
  return new OpenAiProvider({ id: "cloud", baseUrl: "https://synthetic.example.invalid", apiKey: "", defaultChatModel: "fixture", privacy: { shield: "on" },
    fetchImpl: (async (_url, init) => {
      const wire = String(init?.body);
      expect(wire).not.toContain(PRIVATE);
      if (wire.includes("SEED")) { expect(wire).toContain("[EMAIL_1]"); await wait(); }
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "[EMAIL_1]" }, finish_reason: "stop" }] }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
}
function harness(cloud: OpenAiProvider) {
  return startTestHarness({ apiKey: OWNER, namedTokens: () => [MEMBER, SECOND].map((token, index) => ({ name: `member-${index}`, role: "member" as const, sha256: hashHttpToken(token), createdAt: "" })),
    llamaComplete: params => cloud.complete(params),
  });
}
