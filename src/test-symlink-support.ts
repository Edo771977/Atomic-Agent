import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "vitest";

const symlinkCapability = Symbol.for("atomic-agent.tests.windows-symlink-capability");
const worker = process as typeof process & { [symlinkCapability]?: boolean };

function canCreateWindowsSymlinks(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "atomic-test-symlinks-"));
  try {
    const target = join(dir, "target");
    writeFileSync(target, "");
    try {
      symlinkSync(target, join(dir, "link"), "file");
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return false;
      throw error;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Gate genuine symlink fixtures only. Directory junctions need no such privilege. */
export function requireSymlinks(context: Pick<TestContext, "skip">): void {
  if (process.platform !== "win32") return;
  worker[symlinkCapability] ??= canCreateWindowsSymlinks();
  context.skip(!worker[symlinkCapability], "symlinks need Developer Mode or admin on Windows");
}
