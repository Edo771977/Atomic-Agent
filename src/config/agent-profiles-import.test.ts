import { expect, it } from "vitest";
import { parseLlmRunModeConfig, scrubRunModeProviderPins } from "./llm-run-mode-config.js";

it("C1c: retains normalized settings profiles independently of provider pins", () => {
  const parsed = parseLlmRunModeConfig({
    mode: "fusion", agentProfiles: { Auditor: { prompt: "Check the change.", tools: "Read, Grep", model: "review" } },
  }, [], "llm.runMode");
  expect(parsed).toMatchObject({ agentProfiles: { auditor: { prompt: "Check the change.", tools: ["Read", "Grep"], model: "review" } } });
  expect(scrubRunModeProviderPins(parsed, "removed")).toMatchObject({ agentProfiles: parsed.agentProfiles });
});
