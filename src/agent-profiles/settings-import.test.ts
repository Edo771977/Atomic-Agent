import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loadAgentProfiles } from "./profile-loader.js";
import { readSettingsAgentProfiles } from "./settings-profiles.js";
import { buildPrompt } from "../prompt/build-prompt.js";
import { createEmptySessionState, recordTurn } from "../session/session-state.js";
import { userTurn } from "../session/conversation-turn.js";
import { isWorkerVisibleTool } from "../tools/fusion/worker-tool-policy.js";

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
    const options = { workingDir: root, stateDir: root, configFile, startupTrust: undefined,
      settingsProfiles: () => readSettingsAgentProfiles(configFile, () => undefined) };
    for (const mode of ["local", "cloud"] as const) {
      let session = createEmptySessionState({ id: `profile-reload-${mode}`, workingDir: root });
      const build = () => buildPrompt({ session, toolDescriptors: [], skillCatalog: [], toolTransport: "grammar",
        modelMode: { mode, source: "provider", providerId: "test", modelId: null }, capabilities: {
          platform: "linux", arch: "x64", browserChannel: "none", workingDir: root,
          hasClipboard: false, hasWmctrl: false, hasNotifications: false,
        } });
      const prefix = build().stablePrefix;
      for (const prompt of ["First profile instructions", "Second profile instructions"]) {
        const bytes = JSON.stringify({ llm: { runMode: { agentProfiles: { auditor: { prompt } } } } });
        writeFileSync(configFile, bytes);
        const loaded = loadAgentProfiles(options).get("auditor");
        expect(loaded?.prompt).toBe(prompt);
        session = recordTurn(session, userTurn(`Task brief: ${loaded!.prompt}`));
        const next = build();
        expect(next.text).toContain(prompt);
        expect(next.stablePrefix).toBe(prefix);
        expect(next.stablePrefix).not.toContain(prompt);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("C1 review 2: rejects invalid person profiles and retains the valid builtin fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "c1d-tool-admission-"));
  try {
    for (const tools of [["os.fs.read", "unknown.tool"], ["memory.notes.store"], ["os.*"], ["Not A Tool"], ["fusion.delegate"]]) {
      const profiles = loadAgentProfiles({
        workingDir: root, stateDir: root, configFile: join(root, "config.json"), startupTrust: undefined,
        settingsProfiles: () => ({ review: { prompt: "Invalid replacement", tools }, custom: { prompt: "Invalid custom profile", tools } }),
        toolPolicy: { names: ["os.fs.read", "os.screen.click", "memory.notes.store"], allows: isWorkerVisibleTool },
      });
      expect(profiles.get("review")).toMatchObject({ source: "builtin", tools: ["os.fs.read"] });
      expect(profiles.get("review")?.prompt).not.toContain("Invalid replacement");
      expect(profiles.get("custom")).toBeUndefined();
      expect(profiles.diagnostics.join("\n")).toMatch(/review.*rejected.*tool/i);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
