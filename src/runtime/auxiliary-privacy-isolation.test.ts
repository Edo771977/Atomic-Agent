import { afterEach, expect, it } from "vitest";
import { OpenAiProvider } from "../llm/provider/openai/openai-provider.js";
import { resetPrivacyVaults } from "../privacy/index.js";
import { createEmptySessionState } from "../session/session-state.js";
import { generateSessionTitle } from "../session/session-title.js";
import { enhancePrompt } from "./prompt-enhancer.js";

afterEach(resetPrivacyVaults);
const PRIVATE = "synthetic.owner@example.test";
function cloud(answer: string) {
  return new OpenAiProvider({ id: "fixture", baseUrl: "https://fixture.example.invalid", apiKey: "", defaultChatModel: "fixture", privacy: { shield: "on" },
    fetchImpl: (async () => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: answer }, finish_reason: "stop" }] }), { headers: { "content-type": "application/json" } })) as typeof fetch,
  });
}
it("does not reuse enhance:draft substitutions between rewrites", async () => {
  const provider = cloud("Rewrite the request for [EMAIL_1] without changing its intent or adding any extra context.");
  const deps = { complete: (request: Parameters<OpenAiProvider["complete"]>[0]) => provider.complete(request), slotId: () => 1 };
  const first = await enhancePrompt("Write a request about " + PRIVATE, deps);
  expect(first.ok && first.text).toContain(PRIVATE);
  const next = await enhancePrompt("Keep the literal reference [EMAIL_1] in a clear request", deps);
  expect(next.ok && next.text).toContain("[EMAIL_1]");
  expect(next.ok && next.text).not.toContain(PRIVATE);
});
it("gives repeated title generations their own archives while preserving the title partition", async () => {
  const provider = cloud("Note [EMAIL_1]");
  const partitions: string[] = [];
  const deps = { complete: (request: Parameters<OpenAiProvider["complete"]>[0]) => { partitions.push(request.sessionId!); return provider.complete(request); }, slotId: () => 1 };
  const state = createEmptySessionState({ id: "same-title-chat", workingDir: "/fixture" });
  expect(await generateSessionTitle({ ...state, turns: [{ kind: "user", text: PRIVATE, at: 1 }] }, deps)).toContain(PRIVATE);
  expect(await generateSessionTitle({ ...state, turns: [{ kind: "user", text: "Keep [EMAIL_1] literal", at: 1 }] }, deps)).toBe("Note [EMAIL_1]");
  expect(partitions).toEqual(["title:same-title-chat", "title:same-title-chat"]);
});
