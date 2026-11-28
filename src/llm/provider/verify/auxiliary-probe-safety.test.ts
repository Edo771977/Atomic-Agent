import { afterEach, describe, expect, it, vi } from "vitest";
import { runProviderContractProbe } from "./run-contract-probe.js";
import { verifyProviderKey } from "./verify-provider-key.js";
import { forgetLearnedModelParams } from "../openai/model-params.js";
import { PrivacyVault, resetPrivacyVaults, setPrivacyShieldEnabled } from "../../../privacy/index.js";

const deprecated = () => new Response(JSON.stringify({ error: { message: "temperature is not supported" } }), { status: 400 });
afterEach(() => { forgetLearnedModelParams(); resetPrivacyVaults(); vi.restoreAllMocks(); });
describe.each(["key", "contract"] as const)("W4.2 %s probe", kind => {
  function call(fetchImpl: typeof fetch, admission = {}) {
    const target = { label: "fixture", baseUrl: "https://probe.example", apiPathPrefix: "/v1", apiKey: "private-probe-key", model: "alias", probeModels: ["alias"] };
    return kind === "key" ? verifyProviderKey(target, { fetchImpl, ...admission }) : runProviderContractProbe(target, { fetchImpl, ...admission });
  }
  it("rechecks admission on a temperature resend and stops without switching destination", async () => {
    const beforeSend = vi.fn(() => { if (beforeSend.mock.calls.length === 2) throw new Error("policy now refuses"); });
    const fetchImpl = vi.fn(async () => deprecated());
    const result = await call(fetchImpl as typeof fetch, { beforeSend });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(beforeSend).toHaveBeenCalledTimes(2);
    expect(result.detail).toContain("policy now refuses");
  });
  it("keeps the physical budget and a fresh privacy archive for each request", async () => {
    setPrivacyShieldEnabled(true);
    const archives: PrivacyVault[] = [];
    const begin = PrivacyVault.prototype.beginRequest;
    vi.spyOn(PrivacyVault.prototype, "beginRequest").mockImplementation(function (this: PrivacyVault) { archives.push(this); return begin.call(this); });
    const requestBudget = { beforeSend: vi.fn(), onResponse: vi.fn() };
    const fetchImpl = vi.fn(async () => deprecated());
    await call(fetchImpl as typeof fetch, { requestBudget });
    // The contract probe keeps its forced/auto/control rungs plus one temperature resend.
    const count = kind === "key" ? 2 : 4;
    expect(fetchImpl).toHaveBeenCalledTimes(count);
    expect(requestBudget.beforeSend).toHaveBeenCalledTimes(count);
    expect(requestBudget.onResponse.mock.calls).toEqual(Array.from({ length: count }, () => [400]));
    expect(archives).toHaveLength(count);
    expect(new Set(archives).size).toBe(count);
  });
});
