import { expect, it } from "vitest";
import { packedConversationTurns } from "./build-prompt-world-conversation.js";

it("keeps a signed Gemini call in the local packed projection", () => {
  const turns = packedConversationTurns({ droppedSummary: null, visibleTurns: [{
    kind: "assistant_tool_call", tool: "os.fs.read", args: { path: "a.txt" },
    at: 1, thoughtSignature: "opaque-test-signature",
  }] });
  expect(turns[0]).toMatchObject({ thoughtSignature: "opaque-test-signature" });
});
