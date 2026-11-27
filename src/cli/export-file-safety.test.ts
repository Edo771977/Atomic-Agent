import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getConfig, getStateSecretPaths, getTrustConfigPaths, resetConfigCache } from "../config/index.js";
import { createEmptySessionState } from "../session/index.js";
import { writeChatExport } from "../tui/commands/export-command.js";
import { writeExportFile } from "./export-command.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "export-safety-"));
  mkdirSync(join(root, "state"));
  vi.stubEnv("ATOMIC_AGENT_STATE_DIR", join(root, "state"));
  resetConfigCache();
});
afterEach(() => { resetConfigCache(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

for (const kind of ["hard", "symbolic"] as const) {
it.skipIf(process.platform === "win32" && kind === "symbolic").each([false, true])(`refuses ${kind} file aliases (force=%s)`, async force => {
  for (const target of [join(root, "ordinary.md"), join(root, "state", "notes.md")]) {
    writeFileSync(target, "original");
    {
      const path = join(root, `${kind}-${target.includes("state")}.md`);
      if (kind === "symbolic") symlinkSync(target, path, "file"); else linkSync(target, path);
      expect(writeExportFile(path, "replacement", force)).not.toBeNull();
      const chat = createEmptySessionState({ id: "safe", workingDir: root });
      chat.turns.push({ kind: "user", text: "export", at: 1 });
      expect(await writeChatExport(chat, { format: "markdown", path, force }, root)).toMatch(/export failed/);
      expect(readFileSync(target, "utf8")).toBe("original");
    }
  }
});
}

it.each([false, true])("refuses state destinations and a directory alias to state (force=%s)", force => {
  const state = join(root, "state");
  symlinkSync(state, join(root, "alias"), "junction");
  for (const path of [join(state, "new.md"), join(root, "alias", "new.md")]) {
    expect(writeExportFile(path, "replacement", force)).not.toBeNull();
  }
  expect(readdirSync(state)).not.toContain("new.md");
});

it.each([false, true])("refuses secret/trust inventory paths and policy/skill paths (force=%s)", force => {
  mkdirSync(join(root, "policy"));
  mkdirSync(join(root, ".agents", "skills"), { recursive: true });
  const paths = getConfig().paths;
  const protectedFiles = [...getStateSecretPaths(paths), ...getTrustConfigPaths(paths)]
    .filter(path => !/[\\/]$/.test(path));
  for (const path of [...protectedFiles, join(root, "AGENTS.md"), join(root, "SKILL.md"), join(root, "policy", "export.md"), join(root, ".agents", "skills", "export.md")]) {
    expect(writeExportFile(path, "replacement", force)).not.toBeNull();
  }
});

it.each(["AGENT.md", "CLAUDE.md", "GEMINI.md", "POLICY.md", "policy.json", ".cursorrules", ".github/copilot-instructions.md", ".cursor/rules/export.mdc", ".atomic-agent/new.md"])("protects conventional instruction/policy path %s", name => {
  const path = join(root, name);
  mkdirSync(dirname(path), { recursive: true });
  for (const force of [false, true]) expect(writeExportFile(path, "replacement", force)).not.toBeNull();
  expect(() => readFileSync(path)).toThrow();
});

it("keeps exclusive creation and replaces a regular forced destination using an adjacent temporary file", () => {
  const path = join(root, "chat.md");
  expect(writeExportFile(path, "first", false)).toBeNull();
  expect(writeExportFile(path, "second", false)).toMatch(/already exists/);
  expect(readFileSync(path, "utf8")).toBe("first");
  const inode = statSync(path, { bigint: true }).ino;
  expect(writeExportFile(path, "second", true)).toBeNull();
  expect(statSync(path, { bigint: true }).ino).not.toBe(inode);
  expect(readFileSync(path, "utf8")).toBe("second");
  expect(readdirSync(root).sort()).toEqual(["chat.md", "state"]);
});
