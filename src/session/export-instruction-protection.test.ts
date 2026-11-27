import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetConfigCache } from "../config/index.js";
import { rootNames, foreignRootNames } from "../runtime/project-instruction-files.js";
import { PROJECT_AGENT_DIRS } from "../agent-profiles/profile-loader.js";
import { runGitInWorkspace } from "../runtime/project-instructions-git.js";
import { writeExportFile } from "./chat-export-file.js";
import * as shared from "../config/project-instruction-paths.js";
import { protectedProjectExportPath } from "./export-project-paths.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "export-instructions-"));
  vi.stubEnv("ATOMIC_AGENT_STATE_DIR", join(root, "state"));
  resetConfigCache();
  expect(runGitInWorkspace(root, ["init", "--quiet"]).status).toBe(0);
});
afterEach(() => { resetConfigCache(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

for (const force of [false, true]) {
  it.each([...rootNames, ...foreignRootNames])(`protects nested loader name %s (force=${force})`, name => {
    const path = join(root, "pkg", name);
    mkdirSync(dirname(path), { recursive: true });
    if (force) writeFileSync(path, "original");
    expect(writeExportFile(path, "replacement", force, [root])).not.toBeNull();
    if (force) expect(readFileSync(path, "utf8")).toBe("original"); else expect(existsSync(path)).toBe(false);
  });
  it.each([...rootNames, ...foreignRootNames])(`protects ancestor loader name %s up to Git root (force=${force})`, name => {
    const cwd = join(root, "pkg", "work");
    mkdirSync(cwd, { recursive: true });
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    if (force) writeFileSync(path, "original");
    expect(writeExportFile(path, "replacement", force, [cwd])).not.toBeNull();
  });
  it.each(PROJECT_AGENT_DIRS)(`protects nested project profiles in %s (force=${force})`, dir => {
    const path = join(root, "pkg", dir, "review.md");
    mkdirSync(dirname(path), { recursive: true });
    if (force) writeFileSync(path, "original");
    expect(writeExportFile(path, "replacement", force, [root])).not.toBeNull();
  });
}

it.skipIf(process.platform !== "darwin" && process.platform !== "win32").each([...rootNames, ...foreignRootNames])("protects lowercase nested alias %s", name => {
  const path = join(root, "pkg", name.toLowerCase());
  mkdirSync(dirname(path), { recursive: true });
  expect(writeExportFile(path, "replacement", false, [root])).not.toBeNull();
});

it.each(["Policies", "skills"])("keeps ordinary %s folders writable", name => {
  const path = join(root, name, "report.md");
  mkdirSync(dirname(path), { recursive: true });
  expect(writeExportFile(path, "report", false, [root])).toBeNull();
});

it("uses the identical loader/profile discovery definitions", () => {
  expect(rootNames).toBe(shared.rootNames);
  expect(foreignRootNames).toBe(shared.foreignRootNames);
  expect(PROJECT_AGENT_DIRS).toBe(shared.PROJECT_AGENT_DIRS);
});
for (const platform of ["darwin", "win32"] as const) {
  it.each([...rootNames, ...foreignRootNames, ...PROJECT_AGENT_DIRS.map(dir => dir + "/review.md")])(`recognizes lowercase names on ${platform}: %s`, name => {
    expect(protectedProjectExportPath(join(root, "pkg", name.toLowerCase()), [root], ".atomic-agent/skills", platform)).toBe(true);
  });
}
it("does not fold instruction names on Linux", () => {
  expect(protectedProjectExportPath(join(root, "pkg", "agents.md"), [root], ".atomic-agent/skills", "linux")).toBe(false);
});
