import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DEFAULT_TOOL_DESCRIPTORS } from "../prompt/tool-descriptors.js";
import { applyTaskProfiles } from "../tools/fusion/task-profiles.js";
import { isWorkerVisibleTool, workerToolFilterFor } from "../tools/fusion/worker-tool-policy.js";
import { loadAgentProfiles } from "./profile-loader.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "c1-builtin-catalog-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
function load(browser: boolean, names = DEFAULT_TOOL_DESCRIPTORS.map(tool => tool.name), allows = isWorkerVisibleTool) {
  return loadAgentProfiles({ workingDir: root, stateDir: root, configFile: join(root, "config.json"),
    startupTrust: [], toolPolicy: { names: names.filter(name => browser || !name.startsWith("browser.")), allows } });
}

it("C1 review 1: research survives a disabled browser and its worker cannot use browser tools", () => {
  const profiles = load(false);
  expect(profiles.get("research")).toMatchObject({ source: "builtin" });
  expect(profiles.get("research")?.tools?.some(name => name.startsWith("browser."))).toBe(false);
  const applied = applyTaskProfiles([{ id: "r", title: "Research", instructions: "Find sources", profile: "research" }], profiles, []);
  expect(applied.ok).toBe(true);
  if (!applied.ok) throw new Error(applied.error);
  const allows = workerToolFilterFor(applied.tasks[0]!.agentProfile?.tools);
  expect(allows("os.web.fetch")).toBe(true);
  expect(allows("os.fs.read")).toBe(true);
  for (const name of ["browser.navigate", "os.shell.run", "os.fs.write", "fusion.delegate", "memory.notes.store"]) {
    expect(allows(name), name).toBe(false);
  }
});

it("C1 review 1: all three builtins load with the browser enabled", () => {
  const profiles = load(true);
  expect(profiles.profiles.map(profile => profile.name)).toEqual(["explore", "research", "review"]);
  expect(profiles.get("research")?.tools).toContain("browser.navigate");
  expect(profiles.diagnostics).toEqual([]);
});

it("C1 review 1: missing all optional tools never turns a builtin into an unrestricted worker", () => {
  const profiles = load(false, []);
  expect(profiles.profiles).toHaveLength(3);
  for (const profile of profiles.profiles) {
    const applied = applyTaskProfiles([{ id: "r", title: "Read", instructions: "Read", profile: profile.name }], profiles, []);
    if (!applied.ok) throw new Error(applied.error);
    const allows = workerToolFilterFor(applied.tasks[0]!.agentProfile?.tools);
    expect(allows("reply")).toBe(true);
    expect(allows("os.fs.read")).toBe(false);
    expect(allows("os.shell.run")).toBe(false);
    expect(allows("os.fs.write")).toBe(false);
  }
});

it("C1 review 1: an explicitly forbidden builtin tool is rejected even when unregistered", () => {
  const names = DEFAULT_TOOL_DESCRIPTORS.map(tool => tool.name).filter(name => name !== "os.fs.read");
  const profiles = load(false, names, name => isWorkerVisibleTool(name) && name !== "os.fs.read");
  expect(profiles.get("research")).toBeUndefined();
  expect(profiles.diagnostics.join("\n")).toMatch(/research.*rejected.*tool/);
});
