import { describe, expect, it } from "vitest";
import { shellNetworkUrls } from "../tools/os/shell-command-guard/network-clients.js";
import { evaluatePolicy, type EffectivePolicy } from "./policy-evaluator.js";
import { urlResources } from "./policy-targets.js";

describe("recognized shell client policy perimeter", () => {
  it.each([["git", "submodule", "update", "--init"], ["git", "lfs", "pull"], ["git", "remote", "update"], ["git", "fetch", "origin"], ["pip", "install", "fixture"], ["python3", "-m", "pip", "install", "fixture"], ["npm", "install", "fixture"], ["ssh", "fixture.test"], ["scp", "fixture.txt", "fixture.test:fixture.txt"], ["nc", "fixture.test", "443"]])("holds uninspected destinations in %s", (cmd, ...args) => {
    const urls = shellNetworkUrls(cmd, args);
    expect(urls.has("")).toBe(true);
    for (const effect of ["deny", "ask"] as const) {
      const policy: EffectivePolicy = { sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "webfetch", resource: "restricted.test", effect }] };
      expect([...urls.keys()].some(url => evaluatePolicy(policy, "webfetch", urlResources([url]).filter((v): v is string => v !== undefined), { unreadable: url === "" })?.effect === effect)).toBe(true);
    }
  });
  it("does not treat ordinary arguments mentioning a client as a network invocation", () => {
    expect(shellNetworkUrls("printf", ["npm", "install", "fixture"])).toEqual(new Map());
    expect(shellNetworkUrls("git", ["status"])).toEqual(new Map());
  });
});
