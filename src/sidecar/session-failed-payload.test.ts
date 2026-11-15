import { describe, expect, it } from "vitest";

import { makeProviderPolicy } from "../config/project-constraint-match.js";
import { ProviderNotAllowedError } from "../llm/provider-policy.js";
import { sessionFailedPayload } from "./session-failed-payload.js";

describe("sidecar session_failed payload", () => {
  it("keeps error and category, and adds the constraint code and advice", () => {
    const policy = makeProviderPolicy({ key: "/work/client", allowedProviders: ["local-llama"], matchedDir: "/work/client" });
    const error = new ProviderNotAllowedError({ reason: "none-allowed", policy, role: "the main model" });
    const payload = sessionFailedPayload("s1", error, "transport", { localModelConfigured: true });
    expect(payload).toMatchObject({
      sessionId: "s1",
      error: error.message,
      category: "transport",
      code: "ATOMIC_AGENT_PROVIDER_NOT_ALLOWED",
      advice: expect.stringContaining("switch to local with ctrl+r or /runmode local"),
    });
  });

  it("is unchanged for other failures", () => {
    expect(sessionFailedPayload("s1", new Error("fetch failed"), "transport", { localModelConfigured: true })).toEqual({
      sessionId: "s1", error: "fetch failed", category: "transport",
    });
  });
});
