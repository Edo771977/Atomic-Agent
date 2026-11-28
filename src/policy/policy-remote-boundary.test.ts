import { afterEach, describe, expect, it, vi } from "vitest";
import { loadLocalPolicy, loadPolicy } from "./policy-loader.js";
import { parsePolicyFile } from "./policy-schema.js";
import { formatPolicy } from "./policy-show.js";
afterEach(() => vi.unstubAllGlobals());
const url = "https://policy.fixture/private-fixture-path?reserved=fixture-reserved-value";
describe("remote policy transport and display boundary", () => {
  it("uses HTTPS without following redirects in the native transport", async () => {
    const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response('{"rules":[]}'));
    vi.stubGlobal("fetch", fetch);
    const loaded = await loadPolicy({ stateDir: "fixture", env: { ATOMIC_POLICY_URL: url }, readText: () => null, writeText: () => undefined });
    expect(fetch.mock.calls[0]?.[1]?.redirect).toBe("error");
    expect(JSON.stringify(loaded)).not.toContain("private-fixture-path");
    expect(JSON.stringify(loaded)).not.toContain("fixture-reserved-value");
  });
  it("never exposes the complete policy URL or a transport error's token in status/show", async () => {
    const loaded = await loadPolicy({ stateDir: "fixture", env: { ATOMIC_POLICY_URL: url }, readText: () => null,
      fetchText: async () => { throw new Error(`fixture transport error ${url}`); } });
    for (const shown of [JSON.stringify(loaded), formatPolicy(loaded)]) {
      expect(shown).not.toContain("private-fixture-path"); expect(shown).not.toContain("fixture-reserved-value");
      expect(shown).not.toContain(url);
    }
  });
  it("rejects non-HTTPS and credential-bearing policy URLs before transport/cache", async () => {
    for (const target of ["http://policy.fixture/rules", "https://fixture-user:fixture-pass@policy.fixture/rules"]) {
      const fetchText = vi.fn(async () => "{}");
      expect(() => parsePolicyFile({ url: target })).toThrow(/HTTPS|credential/i);
      expect(() => loadLocalPolicy({ stateDir: "fixture", env: { ATOMIC_POLICY_URL: target }, readText: () => null })).toThrow(/HTTPS|credential/i);
      await expect(loadPolicy({ stateDir: "fixture", env: { ATOMIC_POLICY_URL: target }, readText: () => null, fetchText })).rejects.toThrow(/HTTPS|credential/i);
      expect(fetchText).not.toHaveBeenCalled();
    }
  });
});
