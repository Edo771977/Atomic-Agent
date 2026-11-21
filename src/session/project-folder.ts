import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import type { SessionState } from "./session-state.js";

/** The folder a session's project lives in: the worktree's original folder, else the working dir. */
export function projectFolderOf(state: Pick<SessionState, "workingDir" | "worktree">): string {
  return resolve(state.worktree?.originalWorkingDir ?? state.workingDir);
}

/**
 * Folder identity: the real paths (symlinks resolved, the disk's own
 * spelling) are compared exactly, so two folders differing only by case
 * on a case-sensitive volume stay two. A path that does not resolve is
 * compared without case on Windows and macOS.
 */
export function sameProjectFolder(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const real = (p: string): string | null => {
    try {
      return realpathSync.native(p).replace(/\\/g, "/").replace(/\/+$/, "");
    } catch {
      return null;
    }
  };
  const ra = real(a);
  const rb = real(b);
  if (ra !== null && rb !== null) return ra === rb;
  const fold = (p: string) => {
    const r = resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
    return platform === "win32" || platform === "darwin" ? r.toLowerCase() : r;
  };
  return fold(a) === fold(b);
}
