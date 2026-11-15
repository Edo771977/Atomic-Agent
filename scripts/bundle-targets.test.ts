import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUNDLE_TARGETS, betterSqlite3BindingPath } from "./bundle-targets.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkgDir = join(root, "node_modules", "better-sqlite3");

describe("better-sqlite3 binding shipped per bundle target", () => {
  it("names a prebuilt binary the installed package actually contains", () => {
    for (const target of BUNDLE_TARGETS) {
      const rel = betterSqlite3BindingPath(target);
      expect(existsSync(join(pkgDir, rel)), `${target.slug}: ${rel}`).toBe(true);
    }
  });

  it("is N-API, so one binary serves every Node major (no node-gyp install step)", () => {
    const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
      gypfile?: boolean;
      scripts?: Record<string, string>;
    };
    expect(manifest.gypfile).toBe(false);
    expect(manifest.scripts?.install).toBeUndefined();
  });
});
