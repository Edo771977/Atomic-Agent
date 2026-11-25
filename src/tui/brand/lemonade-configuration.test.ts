import { expect, it } from "vitest";
import { findProviderPreset } from "../../llm/provider/presets/provider-presets.js";

it("keeps the older Lemonade port hint when shortening preset rows for badges", () => {
  const preset = findProviderPreset("lemonade");
  expect(preset?.baseUrl).toBe("http://localhost:13305");
  expect(preset?.perAccountEndpoint?.hint).toContain("8000");
});
