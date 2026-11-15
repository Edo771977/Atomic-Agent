import { describe, expect, it } from "vitest";

import { parseTeamMember } from "./fusion-team.js";
import { createSubscriptionCliStatusCache, liveTeamReachability } from "./team-reachability.js";

const member = (ref: string) => parseTeamMember(ref)!;
const providers = [
  { id: "codex", kind: "subscription-cli", subscriptionCli: { cli: "codex", binPath: "/bin/codex" } },
  { id: "api", kind: "anthropic" },
  { id: "gone", kind: "anthropic" },
];
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("the runtime's subscription CLI status cache (issue #37)", () => {
  it("checks in the background, never waits, and reuses a fresh result", async () => {
    const checked: Array<[string, string | undefined]> = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let now = 0;
    const cache = createSubscriptionCliStatusCache({
      check: async (cli, binPath) => { checked.push([cli, binPath]); await gate; return { state: "signed_out" }; },
      now: () => now,
      ttlMs: 1_000,
    });
    cache.refresh("codex", "/bin/codex");
    cache.refresh("codex", "/bin/codex");
    expect(cache.stateOf("codex")).toBeUndefined();
    release();
    await flush();
    expect(cache.stateOf("codex")).toBe("signed_out");
    cache.refresh("codex");
    expect(checked).toHaveLength(1);
    now = 2_000;
    cache.refresh("codex");
    await flush();
    expect(checked).toHaveLength(2);
  });

  it("reads a failed check as not known", async () => {
    const cache = createSubscriptionCliStatusCache({ check: async () => { throw new Error("boom"); } });
    cache.refresh("codex");
    await flush();
    expect(cache.stateOf("codex")).toBeUndefined();
  });
});

describe("liveTeamReachability", () => {
  it("counts a signed-out or missing CLI unreachable, an unchecked one reachable", async () => {
    let state: "ready" | "signed_out" | "missing" = "signed_out";
    const cache = createSubscriptionCliStatusCache({ check: async () => ({ state }), ttlMs: 0 });
    const reachable = liveTeamReachability({ providers, registered: (id) => id !== "gone", cache });
    // Not checked yet: not a refusal; the read starts the check.
    expect(reachable(member("codex:model-a"))).toBe(true);
    await flush();
    expect(reachable(member("codex:model-a"))).toBe(false);
    state = "missing";
    reachable(member("codex:model-a"));
    await flush();
    expect(reachable(member("codex:model-a"))).toBe(false);
    await flush();
    state = "ready";
    reachable(member("codex:model-a"));
    await flush();
    expect(reachable(member("codex:model-a"))).toBe(true);
    expect(reachable(member("api:model-b"))).toBe(true);
    expect(reachable(member("gone:model-b"))).toBe(false);
    expect(reachable(member("nope:model-b"))).toBe(false);
  });
});
