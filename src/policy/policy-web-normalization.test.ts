import { describe, expect, it } from "vitest";
import { policyCallRefusal } from "./policy-enforce.js";
import { mcpServerVerdict, type EffectivePolicy } from "./policy-evaluator.js";
describe("web URL and host policy identities", () => {
  it.each([
    ["EXAMPLE.TEST", "https://example.test/path", true],
    ["BÜCHER.example", "https://xn--bcher-kva.example/page", true],
    ["https://BÜCHER.example:443", "https://xn--bcher-kva.example/page", true],
    ["https://EXAMPLE.test:8443/*", "https://example.test:8443/path", true],
    ["https://example.test:8443/*", "https://example.test:9443/path", false],
    ["https://example.test/*", "http://example.test/path", false],
    ["example.test:443", "https://example.test/path", true],
    ["*.EXAMPLE.test", "http://a.example.test:8080/PATH", true],
    ["https://example.test/Case/*", "https://example.test/case/a", false],
    ["https://example.test/a", "https://example.test/%61", false],
    ["https://example.test/a/b", "https://example.test/a//b", false],
    ["https://example.test/a/b", "https://example.test/a%2Fb", false],
    ["https://example.test/b", "https://example.test/a/../b", true],
  ])("%s on %s has denied=%s", (resource, url, denied) => {
    const policy: EffectivePolicy = { sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "webfetch", resource: resource as string, effect: "deny" }] };
    expect(policyCallRefusal(policy, "os.web.fetch", { url }) !== null).toBe(denied);
  });
  it("normalizes MCP endpoint URL selectors without broadening name selectors", () => {
    const policy: EffectivePolicy = { sources: [], rules: [], mcpAllowlists: [{ source: "system", servers: ["HTTPS://BÜCHER.example:443/mcp"], warnOnly: false }] };
    expect(mcpServerVerdict(policy, { name: "fixture", url: "https://xn--bcher-kva.example/mcp" }).allowed).toBe(true);
    expect(mcpServerVerdict(policy, { name: "fixture", url: "https://xn--bcher-kva.example/other" }).allowed).toBe(false);
  });
});
