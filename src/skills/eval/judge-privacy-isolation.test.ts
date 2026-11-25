import { afterEach, expect, it } from "vitest";
import { OpenAiProvider } from "../../llm/provider/openai/openai-provider.js";
import { resetPrivacyVaults, privacyShieldTotals } from "../../privacy/index.js";
import { createSkillEvalJudge } from "./judge.js";
afterEach(resetPrivacyVaults);
it("does not restore private values from an earlier evaluation case", async () => {
  const provider = new OpenAiProvider({ id: "fixture", baseUrl: "https://fixture.invalid", apiKey: "", defaultChatModel: "fixture", privacy: { shield: "on" }, fetchImpl: (async (_url, init) => {
    expect(String(init?.body)).not.toContain("case.owner@example.test");
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ score: 4, reason: "[EMAIL_1]" }) }, finish_reason: "stop" }] }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch });
  const judge = createSkillEvalJudge({ kind: "provider", providerId: "fixture", model: "fixture", source: "judgeProvider", timeoutMs: 1000 }, { provider });
  const input = { prompt: "case.owner@example.test", reply: "answer", rubric: "check", reference: null };
  expect((await judge.score(input)).reason).toBe("case.owner@example.test");
  expect((await judge.score({ ...input, prompt: "ordinary case" })).reason).toBe("[EMAIL_1]");
  expect(privacyShieldTotals()).toEqual({ masked: 0, sessions: 0 });
});
