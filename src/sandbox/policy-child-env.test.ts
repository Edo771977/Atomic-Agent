import { describe, expect, it } from "vitest";
import { buildCommandEnv, markAgentToolChild } from "./command-env.js";
import { buildMcpStdioEnv } from "../mcp/mcp-stdio-env.js";
describe("operator policy URL stays outside child environments", () => {
  it.each(["ATOMIC_POLICY_URL", "Atomic_Policy_Url"])("removes %s even through passthrough and configured overrides", key => {
    const base = { PATH: "fixture-bin", [key]: "https://policy.example/rules?reserved=fixture-value" };
    for (const env of [buildCommandEnv(base, [key]), markAgentToolChild(base), buildMcpStdioEnv(base, {})]) {
      expect(Object.keys(env).some(name => name.toUpperCase() === "ATOMIC_POLICY_URL")).toBe(false);
      expect(env.PATH).toBe("fixture-bin");
    }
  });
});
