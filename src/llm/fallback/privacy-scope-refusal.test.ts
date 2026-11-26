import { afterEach, expect, it, vi } from "vitest";
import { resetPrivacyVaults, withFreshPrivacyVault } from "../../privacy/index.js";
import { OpenAiProvider } from "../provider/openai/openai-provider.js";
import { TransportError } from "../reliability/llm-failures.js";
import { ProviderFallbackChain } from "./provider-fallback-chain.js";
import { DEFAULT_FALLBACK_TIMING } from "./fallback-config.js";
import { runWithFallback } from "./run-with-fallback.js";
import { shouldAdvance } from "./should-advance.js";

afterEach(resetPrivacyVaults);

function cloud() {
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
  const provider = new OpenAiProvider({ id: "primary", baseUrl: "https://fixture.invalid", apiKey: "", defaultChatModel: "fixture", privacy: { shield: "on" }, fetchImpl });
  return { provider, fetchImpl };
}

it("surfaces a typed scope refusal without downgrading the provider request", async () => {
  const { provider, fetchImpl } = cloud();
  const request = { sessionId: "reflection:Y", prompt: "synthetic", responseFormat: {
    name: "scope_fixture", schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
  } };
  await expect(provider.complete(request)).rejects.toMatchObject({ name: "PrivacyVaultScopeError", code: "privacy_scope_required" });
  expect(fetchImpl).not.toHaveBeenCalled();
  await withFreshPrivacyVault(() => provider.complete(request));
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
  expect(body.response_format).toEqual({ type: "json_schema", json_schema: { ...request.responseFormat, strict: true } });
});

it("does not fall over or demote a provider for a wrapped scope refusal", async () => {
  const { provider, fetchImpl } = cloud();
  let refusal: unknown;
  try { await provider.complete({ sessionId: "reflection:Y", prompt: "synthetic" }); } catch (err) { refusal = err; }
  const wrapped = new TransportError(refusal instanceof Error ? refusal.message : "missing refusal", null, "", { cause: refusal });
  expect(shouldAdvance(wrapped)).toEqual({ advance: false, immediate: false });
  const notice = vi.fn();
  const chain = new ProviderFallbackChain({ resolve: () => ({ chain: ["primary", "unprotected"], timing: DEFAULT_FALLBACK_TIMING }), noticeSink: notice });
  const attempt = vi.fn(async (id: string) => { if (id === "primary") throw wrapped; return "unprotected answer"; });
  await expect(runWithFallback(chain, attempt)).rejects.toBe(wrapped);
  expect(attempt.mock.calls.map(([id]) => id)).toEqual(["primary"]);
  expect(chain.activeOverride).toBeNull();
  expect(chain.pickProvider().providerId).toBe("primary");
  expect(notice).not.toHaveBeenCalled();
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(wrapped.message).toContain("requires withFreshPrivacyVault");
});
