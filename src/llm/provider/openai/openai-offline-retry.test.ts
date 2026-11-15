import { describe, expect, it, vi } from "vitest";

import { OfflineNetworkError } from "../../offline-network.js";
import { OpenAiHttpError, openAiPostJson } from "./openai-http.js";

describe("openai-http under offline mode (ATO-1084)", () => {
  it("does not retry a request offline mode refused", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: new OfflineNetworkError("api.example.com") });
    });
    const err = await openAiPostJson(
      {
        baseUrl: "https://api.example.com",
        apiKey: "key",
        extraHeaders: {},
        requestTimeoutMs: 60_000,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        label: "cloud",
      },
      "/v1/chat/completions",
      {},
      {},
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAiHttpError);
    expect((err as OpenAiHttpError).code).toBe("ATOMIC_AGENT_OFFLINE");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
