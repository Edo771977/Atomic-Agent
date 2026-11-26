import { afterEach, expect, it } from "vitest";
import { OpenAiProvider } from "../../llm/provider/openai/openai-provider.js";
import { forgetPrivacyVault, privacyVaultFor, resetPrivacyVaults } from "../../privacy/index.js";
import { createEmptySessionState } from "../../session/index.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import { createRuntimeGoalRunner } from "./runtime-goal.js";

afterEach(() => resetPrivacyVaults());

it("isolates the goal judge for Y from the real chat goal-judge:Y, including after Y is forgotten", async () => {
  const real = privacyVaultFor("goal-judge:Y");
  real.mask("real.chat@example.test");
  const sent: string[] = [];
  const provider = new OpenAiProvider({
    id: "judge-cloud", baseUrl: "https://judge.example.invalid", apiKey: "", defaultChatModel: "fixture",
    privacy: { shield: "on" },
    fetchImpl: async (_url, init) => {
      sent.push(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        criteria: [{ index: 1, verdict: "met", reason: "[EMAIL_1]" }],
      }) }, finish_reason: "stop" }] }), { headers: { "content-type": "application/json" } });
    },
  });
  const runner = createRuntimeGoalRunner({
    sessionStore: { load: () => null, save: () => {} },
    llmComplete: request => provider.complete(request),
    slotManager: { sideCallSlotId: () => -1 }, resolveTransport: () => "grammar",
    logger: new StructuredLogger({ level: "error", sinks: [] }),
  });
  const evaluate = (criterion: string) => runner.run(
    createEmptySessionState({ id: "Y", workingDir: process.cwd() }), "go",
    { goal: { criteria: [criterion], maxRounds: 1 } },
    async session => ({ session, reason: "reply", stepCount: 1 }),
  );
  const first = await evaluate("judge.only@example.test");
  expect(first.goal?.criteria[0]?.reason).toBe("judge.only@example.test");
  expect(sent[0]).toContain("[EMAIL_1]");
  expect(sent[0]).not.toContain("[EMAIL_2]");
  expect(sent[0]).not.toMatch(/real\.chat@example|judge\.only@example/);
  forgetPrivacyVault("Y");
  const second = await evaluate("plain criterion");
  expect(second.goal?.criteria[0]?.reason).toBe("[EMAIL_1]");
  expect(privacyVaultFor("goal-judge:Y")).toBe(real);
  expect(real.unmask("[EMAIL_1]")).toBe("real.chat@example.test");
  expect(real.unmask("[EMAIL_2]")).toBe("[EMAIL_2]");
});
