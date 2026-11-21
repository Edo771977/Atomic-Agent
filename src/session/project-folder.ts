import { resolve } from "node:path";

import type { SessionState } from "./session-state.js";

/** The folder a session's project lives in: the worktree's original folder, else the working dir. */
export function projectFolderOf(state: Pick<SessionState, "workingDir" | "worktree">): string {
  return resolve(state.worktree?.originalWorkingDir ?? state.workingDir);
}

/** Folder identity: case-insensitive on Windows and macOS. */
export function sameProjectFolder(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const fold = (p: string) => {
    const r = resolve(p).replace(/[\\/]+$/, "");
    return platform === "win32" || platform === "darwin" ? r.toLowerCase().replace(/\\/g, "/") : r;
  };
  return fold(a) === fold(b);
}
