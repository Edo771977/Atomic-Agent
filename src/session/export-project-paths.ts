import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { cursorRulesDir, foreignRootNames, instructionCaseKey, PROJECT_AGENT_DIRS, rootNames } from "../config/project-instruction-paths.js";
import { runGitInWorkspace } from "../runtime/project-instructions-git.js";

function inside(root: string, path: string, platform: NodeJS.Platform): boolean {
  const tail = relative(instructionCaseKey(root, platform), instructionCaseKey(path, platform));
  return tail === "" || (tail !== ".." && !tail.startsWith(`..${sep}`) && !isAbsolute(tail));
}

/** Same bounded, credential-filtered Git lookup as instruction discovery. */
export function exportProjectRoots(workspaces: readonly string[]): string[] {
  const roots = new Set<string>();
  for (const workspace of new Set(workspaces.map(path => resolve(path)))) {
    roots.add(workspace);
    let actual = workspace;
    try { actual = realpathSync.native(workspace); } catch { /* A removed workspace has no discoverable ancestors. */ }
    roots.add(actual);
    if (inside(actual, resolve(homedir()), process.platform)) continue;
    const git = runGitInWorkspace(actual, ["rev-parse", "--show-toplevel"]);
    if (git.status === 0 && git.stdout?.trim()) {
      const top = resolve(git.stdout.trim());
      if (inside(top, actual, process.platform) && !inside(top, resolve(homedir()), process.platform)) roots.add(top);
    }
  }
  return [...roots];
}

export function exportProjectDirectories(skillDir: string): readonly string[] {
  return [".agents", ".claude", ...PROJECT_AGENT_DIRS, cursorRulesDir, skillDir, ".cursor/skills", ".pi/skills"];
}

/** Pure name/scope check, including aliases on Darwin and Windows. No directory traversal. */
export function protectedProjectExportPath(path: string, roots: readonly string[], skillDir: string,
  platform: NodeJS.Platform = process.platform): boolean {
  const key = (value: string) => instructionCaseKey(value.split("\\").join("/"), platform);
  for (const root of roots) {
    if (!inside(root, path, platform)) continue;
    const rel = key(relative(instructionCaseKey(root, platform), instructionCaseKey(path, platform)));
    if ([...rootNames, ...foreignRootNames].some(name => rel === key(name) || rel.endsWith("/" + key(name)))) return true;
    const framed = "/" + rel + "/";
    if (exportProjectDirectories(skillDir).some(dir => framed.includes("/" + key(dir) + "/"))) return true;
  }
  return false;
}
