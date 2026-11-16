import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EXTENSIONS_HEADER, PROJECT_HEADER, SESSION_ID_HEADER } from "./openai-chat-completions.js";
import { startTestHarness, type Harness } from "./test-harness.js";

/**
 * Issue #39: the fusion project flow stops at gates a person decides, so
 * an HTTP session runs it only when its client draws them: an extensions
 * client sending `X-Atomic-Project`. The answer is the session's, stamped
 * on its first turn (`metadata.projectGates`).
 */
describe("project gates over POST /v1/chat/completions", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startTestHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  async function gatesFor(headers: Record<string, string>): Promise<unknown> {
    const response = await fetch(`${harness.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ model: "atomic-agent", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(response.status).toBe(200);
    await response.json();
    const id = response.headers.get(SESSION_ID_HEADER);
    expect(id).toBeTruthy();
    return harness.runtime.sessionStore.load(id!)?.metadata.projectGates;
  }

  it("a plain OpenAI client and an extensions client without the header get no project flow", async () => {
    expect(await gatesFor({})).toBe(false);
    expect(await gatesFor({ [EXTENSIONS_HEADER]: "1" })).toBe(false);
    expect(await gatesFor({ [PROJECT_HEADER]: "1" })).toBe(false);
  });

  it("an extensions client that declares the project card gets it", async () => {
    expect(await gatesFor({ [EXTENSIONS_HEADER]: "1", [PROJECT_HEADER]: "1" })).toBe(true);
  });
});
