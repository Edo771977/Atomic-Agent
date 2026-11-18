import { describe, expect, it } from "vitest";
import {
  assertProviderAllowed,
  currentProviderPolicy,
  intersectProviderPolicies,
  makeProviderPolicy,
  providerPolicyFromStamp,
  runWithProviderPolicy,
  runWithProviderRole,
  tightenCurrentProviderPolicy,
  toProviderPolicyStamp,
} from "./provider-policy.js";

/** Issue #33 group C: read taint tightens the live frame of a turn. */
describe("provider policy read taint", () => {
  const secret = makeProviderPolicy({ key: "/work/secret", allowedProviders: ["local-llama"], matchedDir: "/work/secret", readFrom: ["/work/secret"] });

  it("tightens the running frame, seen by later calls and by nested role frames", async () => {
    await runWithProviderPolicy(undefined, async () => {
      expect(() => assertProviderAllowed("openai", { constraintsActive: () => true })).not.toThrow();
      await runWithProviderRole("a tool", async () => {
        expect(tightenCurrentProviderPolicy(secret)).toBe(true);
      });
      await Promise.resolve();
      expect(currentProviderPolicy()?.key).toBe("/work/secret");
      expect(() => assertProviderAllowed("openai", { constraintsActive: () => true })).toThrow(
        /this session read files from \/work\/secret, which is restricted to: local-llama/,
      );
      expect(() => assertProviderAllowed("local-llama", { constraintsActive: () => true })).not.toThrow();
    }, { role: "the main model" });
  });

  it("does nothing without a frame", () => {
    expect(tightenCurrentProviderPolicy(secret)).toBe(false);
    expect(currentProviderPolicy()).toBeUndefined();
  });

  it("intersects two constraints and keeps where the content came from", () => {
    const folder = makeProviderPolicy({ key: "/work/a", allowedProviders: ["local-llama", "openai"], matchedDir: "/work/a" });
    const both = intersectProviderPolicies(folder, secret);
    expect(both.allowedProviders).toEqual(["local-llama"]);
    expect(both.key).toBe("/work/a + /work/secret");
    expect(both.readFrom).toEqual(["/work/secret"]);
    expect(intersectProviderPolicies(secret, secret)).toBe(secret);
    // The stamp keeps it across /resume.
    expect(providerPolicyFromStamp(toProviderPolicyStamp(both))?.readFrom).toEqual(["/work/secret"]);
  });

  it("same key or a covered key: the lists still intersect, so a stricter snapshot is kept (issue #74)", () => {
    // A Retry stamp taken while /work/secret allowed only local-llama, applied after it was loosened.
    const loosened = makeProviderPolicy({ key: "/work/secret", allowedProviders: ["local-llama", "openai"], allowedEgress: ["web", "git"], matchedDir: "/work/secret" });
    const stamp = makeProviderPolicy({ key: "/work/secret", allowedProviders: ["local-llama"], allowedEgress: ["git"], matchedDir: "/work/secret", movedFrom: ["/work/old"] });
    const both = intersectProviderPolicies(loosened, stamp);
    expect(both.key).toBe("/work/secret");
    expect(both.allowedProviders).toEqual(["local-llama"]);
    expect(both.allowedEgress).toEqual(["git"]);
    expect(both.movedFrom).toEqual(["/work/old"]);
    // `a` already carries b's key as a part: still the stricter lists.
    const joined = makeProviderPolicy({ key: "/work/a + /work/secret", allowedProviders: ["local-llama", "openai"], allowedEgress: ["web"], matchedDir: "/work/a" });
    const covered = intersectProviderPolicies(joined, stamp);
    expect(covered.key).toBe("/work/a + /work/secret");
    expect(covered.allowedProviders).toEqual(["local-llama"]);
    expect(covered.allowedEgress).toEqual([]);
  });
});
