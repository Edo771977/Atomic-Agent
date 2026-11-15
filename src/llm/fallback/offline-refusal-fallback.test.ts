import { describe, expect, it } from "vitest";

import { DEFAULT_FALLBACK_TIMING } from "./fallback-config.js";
import { isOutageFailure } from "./link-failure-kind.js";
import { newAdvanceTurn, ProviderFallbackChain } from "./provider-fallback-chain.js";
import { shouldAdvance } from "./should-advance.js";
import { OfflineNetworkError } from "../offline-network.js";
import { OpenAiHttpError } from "../provider/openai/openai-http.js";

/** What a cloud link throws while offline: the dispatcher's refusal under fetch's TypeError. */
function offlineCloudError(): OpenAiHttpError {
  const fetchFailed = new TypeError("fetch failed", { cause: new OfflineNetworkError("api.example.com") });
  return new OpenAiHttpError(
    "openai provider network error: fetch failed",
    null,
    "https://api.example.com/v1/chat/completions",
    false,
    null,
    "cloud",
    "ATOMIC_AGENT_OFFLINE",
    { cause: fetchFailed },
  );
}

describe("offline refusal in the fallback chain (ATO-1084)", () => {
  it("advances without the immediate breaker signal", () => {
    expect(shouldAdvance(offlineCloudError())).toEqual({ advance: true, immediate: false });
  });

  it("advances on a bare refusal (subscription CLI providers throw it as is)", () => {
    expect(shouldAdvance(new OfflineNetworkError("api.anthropic.com", "claude-code")).advance).toBe(true);
  });

  it("is not an outage: waiting does not lift it", () => {
    expect(isOutageFailure(offlineCloudError())).toBe(false);
  });

  it("does not quarantine the cloud link once the switch is off again", () => {
    const now = 1_000_000;
    const chain = new ProviderFallbackChain({
      resolve: () => ({ chain: ["cloud", "local"], timing: DEFAULT_FALLBACK_TIMING }),
      now: () => now,
    });
    const turn = newAdvanceTurn();
    expect(chain.advanceFrom("cloud", offlineCloudError(), undefined, turn)).toBe("local");
    // Three offline turns in a row would trip the threshold if they counted.
    chain.advanceFrom("cloud", offlineCloudError(), undefined, newAdvanceTurn());
    chain.advanceFrom("cloud", offlineCloudError(), undefined, newAdvanceTurn());
    // Back online: the next turn goes straight back to the primary.
    expect(chain.pickProvider()).toEqual({ providerId: "cloud", isProbe: true });
  });
});
