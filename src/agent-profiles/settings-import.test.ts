import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loadAgentProfiles } from "./profile-loader.js";
import { readSettingsAgentProfiles } from "./settings-profiles.js";
import { buildStablePrefix } from "../prompt/stable-prefix.js";

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

it("C1d: rereads config bytes without moving an open session's stable prefix", () => {
  const root = mkdtempSync(join(tmpdir(), "c1d-stable-prefix-"));
  try {
    const configFile = join(root, "config.json");
    const build = () => buildStablePrefix({ toolDescriptors: [], skillCatalog: [], toolTransport: "grammar", capabilities: {
      platform: "linux", arch: "x64", browserChannel: "none", workingDir: root,
      hasClipboard: false, hasWmctrl: false, hasNotifications: false,
    } });
    const prefix = build();
    const options = { workingDir: root, stateDir: root, configFile, startupTrust: undefined,
      settingsProfiles: () => readSettingsAgentProfiles(configFile, () => undefined) };
    for (const prompt of ["First", "Second"]) {
      const bytes = JSON.stringify({ llm: { runMode: { agentProfiles: { auditor: { prompt } } } } });
      writeFileSync(configFile, bytes);
      expect(loadAgentProfiles(options).get("auditor")?.prompt).toBe(prompt);
      expect(build()).toBe(prefix);
    }
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
