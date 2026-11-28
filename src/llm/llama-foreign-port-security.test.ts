import { describe, expect, it, vi } from "vitest";
import { LlamaServerClient, LlamaServerError } from "./llama-server-client.js";

describe("W4.1 foreign managed port", () => {
  for (const stream of [false, true]) {
    it(`never sends a credential or retries a foreign 401 (${stream ? "stream" : "unary"})`, async () => {
      const refreshApiKey = vi.fn(async () => "refreshed-secret");
      const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ error: {
        message: "foreign-process-identity provider-secret", type: "private-identity",
      } }), { status: 401 }));
      const client = new LlamaServerClient({
        baseUrl: "http://127.0.0.1:9931", apiKey: "provider-secret", completionRetries: 4,
        progressWatch: false, refreshApiKey, fetchImpl: fetchImpl as typeof fetch,
        ownEngineState: () => "gone",
      });
      const error: unknown = await (stream ? client.completeStream({ prompt: "p" }).next() : client.complete({ prompt: "p" })).catch(e => e);
      expect(error).toBeInstanceOf(LlamaServerError);
      expect((error as LlamaServerError).status).toBe(401);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
      expect(new Headers(init.headers).has("authorization")).toBe(false);
      expect(refreshApiKey).not.toHaveBeenCalled();
      expect((error as Error).message).toContain("Another program answers");
      const visible = JSON.stringify(error, Object.getOwnPropertyNames(error));
      expect(visible).not.toMatch(/provider-secret|refreshed-secret|foreign-process-identity|private-identity/);
      expect((error as Error).cause).toBeUndefined();
      expect((error as LlamaServerError).body).toBeUndefined();
    });
  }
});
