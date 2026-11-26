import { existsSync } from "node:fs";
import { expect, it } from "vitest";
import { findIntegration, listIntegrations } from "./integration-registry.js";

it("keeps Monid browser sign-in and disconnect absent from the integrations hub", () => {
  expect(findIntegration("monid")).toBeUndefined();
  expect(listIntegrations().some(integration => integration.id === "monid")).toBe(false);
  expect(existsSync(new URL("monid-integration.ts", import.meta.url))).toBe(false);
  expect(existsSync(new URL("../tui/integrations/integrations-orchestrator-monid.ts", import.meta.url))).toBe(false);
});
