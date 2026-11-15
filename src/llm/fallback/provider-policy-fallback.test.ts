import { describe, expect, it } from "vitest";

import { DEFAULT_FALLBACK_TIMING } from "./fallback-config.js";
import { isOutageFailure } from "./link-failure-kind.js";
import { newAdvanceTurn, ProviderFallbackChain } from "./provider-fallback-chain.js";
import { runWithFallback } from "./run-with-fallback.js";
import { shouldAdvance } from "./should-advance.js";
import { classifyFailure } from "../reliability/classify-failure.js";
import {
  makeProviderPolicy,
  ProviderNotAllowedError,
  runWithProviderPolicy,
} from "../provider-policy.js";

const onlyLocal = makeProviderPolicy({ key: "/work/client", allowedProviders: ["local"], matchedDir: "/work/client" });
const nobody = makeProviderPolicy({ key: "/work/vault", allowedProviders: [], matchedDir: "/work/vault" });
const refusal = () => new ProviderNotAllowedError({ reason: "not-allowed", providerId: "cloud", policy: onlyLocal });

function chainOf(ids: string[], now = () => 1_000_000) {
  return new ProviderFallbackChain({
    resolve: () => ({ chain: ids, timing: DEFAULT_FALLBACK_TIMING }),
    now,
  });
}

describe("provider-policy refusal in the fallback chain", () => {
  it("advances without the immediate breaker signal and is never an outage", () => {
    expect(shouldAdvance(refusal())).toEqual({ advance: true, immediate: false });
    expect(shouldAdvance(new Error("x", { cause: refusal() }))).toEqual({ advance: true, immediate: false });
    expect(isOutageFailure(refusal())).toBe(false);
    expect(classifyFailure(refusal())).toBe("transport");
  });

  it("records no breaker failure, cooldown or sticky override for a refused link", () => {
    const chain = chainOf(["cloud", "local"]);
    for (let i = 0; i < 5; i += 1) {
      expect(chain.advanceFrom("cloud", refusal(), "s1", newAdvanceTurn())).toBe("local");
    }
    expect(chain.activeOverrideFor("s1")).toBeNull();
    expect(chain.pickProvider("s1")).toEqual({ providerId: "cloud", isProbe: false });
  });

  it("skips a disallowed primary and starts on the first allowed link", async () => {
    const chain = chainOf(["cloud", "other-cloud", "local"]);
    const tried: string[] = [];
    const served = await runWithProviderPolicy(onlyLocal, () =>
      runWithFallback(chain, async (id) => {
        tried.push(id);
        return id;
      }, "s1"));
    expect(served).toBe("local");
    expect(tried).toEqual(["local"]);
    // Nothing about the skipped primary sticks once the folder changes.
    expect(chain.activeOverrideFor("s1")).toBeNull();
    expect(await runWithProviderPolicy(undefined, () => runWithFallback(chain, async (id) => id, "s1"))).toBe("cloud");
  });

  it("refuses with the folder, the allowed list and the role when no link is allowed", async () => {
    const chain = chainOf(["cloud", "local"]);
    let called = false;
    const run = runWithProviderPolicy(nobody, () =>
      runWithFallback(chain, async () => {
        called = true;
        return "x";
      }, "s1"), { role: "the main model" });
    await expect(run).rejects.toThrow("folder /work/vault is restricted to: no provider; no allowed provider can serve the main model");
    expect(called).toBe(false);
  });

  it("turns a chain that ran out on refusals into the terminal refusal", async () => {
    // The chain resolver allows the link, but the attempt refuses it (an
    // unknown id that resolved to another provider): still terminal.
    const chain = chainOf(["local"]);
    const run = runWithProviderPolicy(onlyLocal, () =>
      runWithFallback(chain, async () => {
        throw refusal();
      }, "s1"), { role: "compaction" });
    await expect(run).rejects.toThrow(/no allowed provider can serve compaction/);
  });
});
