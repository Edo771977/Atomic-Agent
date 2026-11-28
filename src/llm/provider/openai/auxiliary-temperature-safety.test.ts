import { afterEach, describe, expect, it, vi } from "vitest";
import { guardProvider, makeProviderPolicy, runWithProviderPolicy } from "../../provider-policy.js";
import { resetOfflineNetworkForTests, setOfflineNetwork } from "../../offline-network.js";
import { PrivacyVault, resetPrivacyVaults, setPrivacyKnownSecrets, setPrivacyShieldEnabled } from "../../../privacy/index.js";
import { OpenAiProvider } from "./openai-provider.js";
import { describeImageViaOpenAi } from "./openai-describe-image.js";
import { forgetLearnedModelParams } from "./model-params.js";
import type { OpenAiHttpDeps } from "./openai-http.js";
import { openAiFetch } from "./openai-http.js";

const request = { prompt: "Describe for alice@example.com", images: [] };
const refusal = () => new Response(JSON.stringify({ error: { message: "temperature is not supported for this model" } }), { status: 400 });
const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: "[EMAIL_1]" } }], usage: { prompt_tokens: 2, completion_tokens: 1 } }));
function setup(onFirst: () => void = () => {}, replies = [refusal, ok]) {
  const fetchImpl = vi.fn(async (_url: unknown, _init?: RequestInit) => {
    const index = fetchImpl.mock.calls.length - 1;
    if (index === 0) onFirst();
    return (replies[index] ?? replies.at(-1)!)();
  });
  const deps: OpenAiHttpDeps = { baseUrl: "https://gateway.example", apiKey: "private-provider-key", extraHeaders: {}, requestTimeoutMs: 1000, label: "gateway", fetchImpl: fetchImpl as typeof fetch };
  return { deps, fetchImpl };
}
afterEach(() => { vi.restoreAllMocks(); forgetLearnedModelParams(); resetPrivacyVaults(); resetOfflineNetworkForTests(); });

describe("W4.2 auxiliary temperature resend", () => {
  it("pins provider, endpoint and credential even if the caller changes its dependencies during the first request", async () => {
    const { deps, fetchImpl } = setup(() => { deps.baseUrl = "https://other.example"; deps.apiKey = "other-key"; });
    await describeImageViaOpenAi(deps, "alias", request);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(["https://gateway.example/v1/chat/completions", "https://gateway.example/v1/chat/completions"]);
    expect(fetchImpl.mock.calls.map(([, init]) => new Headers(init?.headers).get("authorization"))).toEqual(["Bearer private-provider-key", "Bearer private-provider-key"]);
  });
  it("rechecks provider policy and project constraints before the resend", async () => {
    let blocked = false;
    const { deps, fetchImpl } = setup(() => { blocked = true; });
    const provider = guardProvider(new OpenAiProvider({ id: "gateway", ...deps, defaultChatModel: "alias", supportsVision: true }), { constraintsActive: () => true });
    const policy = { ...makeProviderPolicy({ key: "/project", matchedDir: "/project", allowedProviders: ["gateway"] }), allows: () => !blocked };
    await expect(runWithProviderPolicy(policy, () => provider.describeImage(request))).rejects.toThrow(/may not serve/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("refuses missing project policy if constraints become active before the resend", async () => {
    let constrained = false;
    const { deps, fetchImpl } = setup(() => { constrained = true; });
    const provider = guardProvider(new OpenAiProvider({ id: "gateway", ...deps, defaultChatModel: "alias", supportsVision: true }), { constraintsActive: () => constrained });
    await expect(provider.describeImage(request)).rejects.toThrow(/carries no folder policy/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("rechecks the caller's egress admission for each send", async () => {
    const { deps, fetchImpl } = setup();
    const beforeSend = vi.fn(() => { if (beforeSend.mock.calls.length === 2) throw new Error("egress denied"); });
    await expect(describeImageViaOpenAi(deps, "alias", { ...request, beforeSend })).rejects.toThrow("egress denied");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("honors offline mode enabled after the first response", async () => {
    const { deps, fetchImpl } = setup(() => setOfflineNetwork(true));
    await expect(describeImageViaOpenAi(deps, "alias", request)).rejects.toThrow(/offline/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("masks both calls with different archives and restores the answer", async () => {
    const archives: PrivacyVault[] = [];
    const begin = PrivacyVault.prototype.beginRequest;
    vi.spyOn(PrivacyVault.prototype, "beginRequest").mockImplementation(function (this: PrivacyVault) { archives.push(this); return begin.call(this); });
    setPrivacyShieldEnabled(true);
    setPrivacyKnownSecrets(() => [{ label: "provider", value: "private-provider-key", exact: true }]);
    const { deps, fetchImpl } = setup();
    const provider = new OpenAiProvider({ id: "gateway", ...deps, defaultChatModel: "alias", supportsVision: true, privacy: { shield: "on" } });
    const result = await provider.describeImage({ ...request, prompt: request.prompt + " private-provider-key" });
    expect(result.text).toBe("alice@example.com");
    expect(archives).toHaveLength(2);
    expect(archives[0]).not.toBe(archives[1]);
    for (const [, init] of fetchImpl.mock.calls) expect(String(init?.body)).not.toMatch(/alice@example.com|private-provider-key/);
  });
  it("counts both sends against the same budget", async () => {
    const { deps, fetchImpl } = setup();
    const requestBudget = { beforeSend: vi.fn(), onResponse: vi.fn() };
    await describeImageViaOpenAi(deps, "alias", { ...request, requestBudget });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(requestBudget.beforeSend).toHaveBeenCalledTimes(2);
    expect(requestBudget.onResponse.mock.calls).toEqual([[400], [200]]);
  });
  it.each(["top_k is unsupported; request had temperature: 0", "temperature must be between 0 and 1", "unsupported parameter: max_tokens; temperature: 0"])("does not retry an unrelated refusal: %s", async message => {
    const { deps, fetchImpl } = setup(() => {}, [() => new Response(JSON.stringify({ error: { message } }), { status: 400 })]);
    await expect(describeImageViaOpenAi(deps, "alias", request)).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("never repeats a second temperature refusal or exposes its key", async () => {
    const { deps, fetchImpl } = setup(() => {}, [refusal, () => new Response(JSON.stringify({ error: { message: "temperature is not supported private-provider-key" } }), { status: 400 })]);
    const error = await describeImageViaOpenAi(deps, "alias", request).catch(e => e);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((error as Error).message).not.toContain("private-provider-key");
  });
  it("redacts credentials from network errors and their causes without losing errno", async () => {
    const { deps } = setup();
    deps.fetchImpl = (async () => { throw Object.assign(new Error("private-provider-key failed", {
      cause: Object.assign(new Error("nested private-provider-key"), { code: "ECONNREFUSED" }),
    }), { code: "ECONNREFUSED" }); }) as typeof fetch;
    const error = await openAiFetch(deps, "/v1/chat/completions", {}, {}, false, "POST").catch(e => e);
    expect(error.code).toBe("ECONNREFUSED");
    for (let current = error; current; current = current.cause) {
      expect(current.message).not.toContain("private-provider-key");
      expect(current.stack ?? "").not.toContain("private-provider-key");
    }
  });
});
