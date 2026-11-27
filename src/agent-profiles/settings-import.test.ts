import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loadAgentProfiles } from "./profile-loader.js";

it("C1d: loads fresh settings on each profile load", () => {
  const root = mkdtempSync(join(tmpdir(), "c1d-profiles-"));
  try {
    let prompt = "First instructions";
    const options = {
      workingDir: root, stateDir: root, configFile: join(root, "config.json"), startupTrust: undefined,
      settingsProfiles: () => ({ auditor: { prompt, tools: ["Read"] } }),
    };
    expect(loadAgentProfiles(options).get("auditor")).toMatchObject({ source: "settings", prompt });
    prompt = "Updated instructions";
    expect(loadAgentProfiles(options).get("auditor")).toMatchObject({ source: "settings", prompt });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
