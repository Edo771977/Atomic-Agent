import { realpathSync } from "node:fs";

/** Filesystem identity shared by Verify's cwd guard and its turn grants. */
export function canonicalVerifyPath(path: string): string {
  const canonical = realpathSync.native(path);
  return process.platform === "win32" ? canonical.replace(/^[a-z]:/i, drive => drive.toUpperCase()) : canonical;
}

/** A missing or inaccessible folder cannot receive or reuse a turn grant. */
export function verifyPageFolderKey(path: string): string | undefined {
  try {
    return canonicalVerifyPath(path);
  } catch {
    return undefined;
  }
}
