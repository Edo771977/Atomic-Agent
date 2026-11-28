import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loadAgentProfiles } from "./profile-loader.js";
import { readSettingsAgentProfiles } from "./settings-profiles.js";
import { buildPrompt } from "../prompt/build-prompt.js";
import { createEmptySessionState, recordTurn } from "../session/session-state.js";
import { userTurn } from "../session/conversation-turn.js";
import { isWorkerVisibleTool, workerToolFilterFor } from "../tools/fusion/worker-tool-policy.js";
import { DEFAULT_TOOL_DESCRIPTORS } from "../prompt/tool-descriptors.js";
import { applyTaskProfiles } from "../tools/fusion/task-profiles.js";
import { renderWorkerBrief } from "../tools/fusion/worker-prompt.js";

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
      settingsProfiles: () => readSettingsAgentProfiles(configFile, () => undefined),
      toolPolicy: { names: DEFAULT_TOOL_DESCRIPTORS.map(tool => tool.name), allows: isWorkerVisibleTool } };
    for (const mode of ["local", "cloud"] as const) {
      let session = createEmptySessionState({ id: `profile-reload-${mode}`, workingDir: root });
      const build = (toolDescriptors: typeof DEFAULT_TOOL_DESCRIPTORS) => buildPrompt({ session, toolDescriptors,
        skillCatalog: [], toolTransport: "grammar", toolRole: "builder",
        modelMode: { mode, source: "provider", providerId: "test", modelId: null }, capabilities: {
          platform: "linux", arch: "x64", browserChannel: "none", workingDir: root,
          hasClipboard: false, hasWmctrl: false, hasNotifications: false,
        } });
      let prefix: string | undefined;
      for (const prompt of ["First profile instructions", "Second profile instructions"]) {
        const bytes = JSON.stringify({ llm: { runMode: { agentProfiles: {
          auditor: { prompt, tools: ["os.fs.read", "os.web.fetch"] },
        } } } });
        writeFileSync(configFile, bytes);
        const profiles = loadAgentProfiles(options);
        const loaded = profiles.get("auditor");
        expect(loaded?.prompt).toBe(prompt);
        const applied = applyTaskProfiles([{ id: "audit", title: "Audit", instructions: "Read and report", profile: "auditor" }], profiles, []);
        if (!applied.ok) throw new Error(applied.error);
        const task = applied.tasks[0]!;
        expect(task.agentProfile).toMatchObject({ source: "settings", prompt, tools: ["os.fs.read", "os.web.fetch"] });
        const filter = workerToolFilterFor(task.agentProfile?.tools);
        const catalog = DEFAULT_TOOL_DESCRIPTORS.filter(tool => filter(tool.name));
        expect(catalog.map(tool => tool.name)).toEqual(expect.arrayContaining(["os.fs.read", "os.web.fetch"]));
        session = recordTurn(session, userTurn(renderWorkerBrief(task, { workingDir: root, localLeg: mode === "local" })));
        const next = build(catalog);
        expect(next.text).toContain(prompt);
        expect(next.text).toContain("PROFILE auditor (settings)");
        expect(next.stablePrefix).toContain("os.fs.read");
        prefix ??= next.stablePrefix;
        expect(next.stablePrefix).toBe(prefix);
        expect(next.stablePrefix).not.toContain(prompt);
        // Sensitivity control: a real catalog change must change prefix bytes.
        expect(build(catalog.filter(tool => tool.name !== "os.web.fetch")).stablePrefix).not.toBe(prefix);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("C1 second review: rejected person profiles reserve their names against builtin fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "c1d-tool-admission-"));
  try {
    for (const tools of [["os.fs.read", "unknown.tool"], ["memory.notes.store"], ["os.*"], ["Not A Tool"], ["fusion.delegate"]]) {
      const profiles = loadAgentProfiles({
        workingDir: root, stateDir: root, configFile: join(root, "config.json"), startupTrust: undefined,
        settingsProfiles: () => ({ review: { prompt: "Invalid replacement", tools }, custom: { prompt: "Invalid custom profile", tools } }),
        toolPolicy: { names: ["os.fs.read", "os.screen.click", "memory.notes.store"], allows: isWorkerVisibleTool },
      });
      expect(profiles.get("review")).toBeUndefined();
      expect(profiles.get("custom")).toBeUndefined();
      expect(profiles.diagnostics.join("\n")).toMatch(/review.*rejected.*tool/i);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
