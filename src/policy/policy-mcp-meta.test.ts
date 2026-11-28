import { describe, expect, it } from "vitest";
import { toolCallTarget } from "./policy-targets.js";
import { policyCallRefusal } from "./policy-enforce.js";
import type { EffectivePolicy } from "./policy-evaluator.js";

describe("MCP discovery policy identity", () => {
  it.each(["resource.list", "resource.read", "prompt.list", "prompt.get"])("%s uses args.server", operation => {
    const resource = `fixture-server/${operation}`;
    const policy: EffectivePolicy = { sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "mcp", effect: "deny", resource }] };
    expect(toolCallTarget(`mcp.${operation}`, { server: "fixture-server" })).toMatchObject({ action: "mcp", resources: [resource] });
    expect(policyCallRefusal(policy, `mcp.${operation}`, { server: "fixture-server" })).toContain("policy");
    expect(policyCallRefusal(policy, `mcp.${operation}`, { server: "other-server" })).toBeNull();
  });
});
