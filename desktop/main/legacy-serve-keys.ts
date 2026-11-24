import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** Skip other running Desktop instances, including concurrent development runs. */
export function cleanStaleServeKeys(directory: string): void {
  let entry;
  try {
    entry = lstatSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!entry.isDirectory() || (process.platform !== "win32" &&
    (entry.uid !== process.getuid?.() || (entry.mode & 0o777) !== 0o700))) {
    throw new Error("Unsafe legacy serve key directory");
  }

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = /^serve-key-([1-9][0-9]{0,9})-[0-9a-f]{32}$/.exec(entry.name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid > 0x7fffffff) continue;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
      try {
        unlinkSync(join(directory, entry.name));
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
      }
    }
  }
}
