import { afterEach, describe, expect, it, vi } from "vitest";

import { anthropicAuth, fetchAnthropicModels, isNativeAnthropicEntry } from "./anthropic-models.js";

describe("native Anthropic model discovery", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists with x-api-key, the current anthropic-version and the largest page", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "claude-b" }, { id: "claude-a" }], has_more: false }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const ids = await fetchAnthropicModels("sk-ant-test", { baseUrl: "https://anthropic-models-test.invalid/v1" });
    expect(ids).toEqual(["claude-a", "claude-b"]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://anthropic-models-test.invalid/v1/models?limit=1000");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["anthropic-version"]).toBe("2026-10-21");
    expect(headers.authorization).toBeUndefined();
  });

  it("upgrades the old preset's pinned version and keeps an operator's own", () => {
    expect(anthropicAuth({ headers: { "anthropic-version": "2023-06-01" } }).headers).toEqual({
      "anthropic-version": "2026-10-21",
    });
    expect(anthropicAuth({ headers: { "anthropic-version": "2026-01-01" } }).headers).toEqual({
      "anthropic-version": "2026-01-01",
    });
  });

  it("counts the native kind and the old compat entry on api.anthropic.com", () => {
    expect(isNativeAnthropicEntry({ kind: "anthropic" })).toBe(true);
    expect(isNativeAnthropicEntry({ kind: "openai-compatible", baseUrl: "https://api.anthropic.com" })).toBe(true);
    expect(isNativeAnthropicEntry({ kind: "openai-compatible", baseUrl: "https://gateway.example" })).toBe(false);
  });
});
