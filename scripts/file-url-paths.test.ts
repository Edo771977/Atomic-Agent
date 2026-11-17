import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// `new URL(..., import.meta.url).pathname` is a POSIX-only path: on Windows it
// is "/D:/a/repo/..." and node:path then resolves it to "D:\D:\a\repo\...".
// The bug is invisible on Linux/macOS CI, so this guard scans the sources for
// the pattern instead of waiting for the Windows job to hit ENOENT.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCANNED = ["src", "scripts", "eval", "eval-memory"];
const SKIP = new Set(["node_modules", "dist", "fixtures", ".git"]);
const SOURCE = /\.(?:[cm]?[jt]s|tsx)$/;
const PATTERN = /import\.meta\.url\s*\)\s*\.pathname/;

function* walk(dir: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (SOURCE.test(entry.name)) yield path;
  }
}

describe("file URL to path conversion", () => {
  it("shows why URL.pathname is not a Windows path", () => {
    const url = new URL(".", "file:///D:/a/repo/eval/promptfoo/workspace.test.ts");
    expect(url.pathname).toBe("/D:/a/repo/eval/promptfoo/");
    expect(fileURLToPath(url, { windows: true })).toBe("D:\\a\\repo\\eval\\promptfoo\\");
  });

  it("never derives a filesystem path from import.meta.url's pathname", () => {
    const offenders: string[] = [];
    for (const top of SCANNED) {
      for (const file of walk(join(ROOT, top))) {
        if (PATTERN.test(readFileSync(file, "utf8"))) offenders.push(relative(ROOT, file));
      }
    }
    // This file names the pattern in its own comments.
    expect(offenders.filter((file) => !file.endsWith("file-url-paths.test.ts"))).toEqual([]);
  });
});
