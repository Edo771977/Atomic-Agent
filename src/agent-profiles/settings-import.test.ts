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

it("C1d: rejects unknown or forbidden profile tools with a diagnostic", () => {
  const root = mkdtempSync(join(tmpdir(), "c1d-tool-admission-"));
  try {
    for (const tools of [["os.fs.read", "unknown.tool"], ["memory.notes.store"], ["os.*"], ["Not A Tool"]]) {
      const profiles = loadAgentProfiles({
        workingDir: root, stateDir: root, configFile: join(root, "config.json"), startupTrust: undefined,
        settingsProfiles: () => ({ review: { prompt: "Review", tools } }),
        toolPolicy: { names: ["os.fs.read", "os.screen.click", "memory.notes.store"], allows: name => name === "os.fs.read" },
      });
      expect(profiles.get("review")).toBeUndefined();
      expect(profiles.diagnostics.join("\n")).toMatch(/review.*rejected.*tool/i);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
