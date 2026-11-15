/**
 * npm 12 blocks dependency install scripts unless package.json's
 * `allowScripts` decides them. Every lockfile package that npm marks with
 * `hasInstallScript` must have a name-only decision (`true` or `false`), so a
 * new native dependency fails here instead of on a contributor's `npm ci`.
 *
 * A package that ships a `binding.gyp` counts too, whatever its lockfile
 * says: npm 12 reports its implicit `node-gyp rebuild` as blocked even when
 * the package sets `"gypfile": false` (seen on Windows with better-sqlite3
 * 13.x, which loads its prebuilt N-API binary and must never be compiled,
 * issue #29). Such a package is denied with `false` to silence the warning.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

interface LockEntry {
  name?: string;
  hasInstallScript?: boolean;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

/** `node_modules/a/node_modules/@s/b` → `@s/b`. */
function packageNameOf(lockPath: string, entry: LockEntry): string {
  if (entry.name) return entry.name;
  const at = lockPath.lastIndexOf("node_modules/");
  return lockPath.slice(at + "node_modules/".length);
}

const lock = readJson("package-lock.json") as { packages: Record<string, LockEntry> };
const pkg = readJson("package.json") as { allowScripts?: Record<string, unknown> };
const withScripts = [
  ...new Set(
    Object.entries(lock.packages)
      .filter(([path, entry]) => path !== "" && (entry.hasInstallScript === true || existsSync(join(root, path, "binding.gyp"))))
      .map(([path, entry]) => packageNameOf(path, entry)),
  ),
].sort();

describe("package.json allowScripts policy", () => {
  it("decides every lockfile package that has an install script", () => {
    const decided = Object.keys(pkg.allowScripts ?? {});
    expect(withScripts.filter((name) => !decided.includes(name))).toEqual([]);
  });

  it("uses name-only boolean entries, so a version bump never re-blocks", () => {
    for (const [key, value] of Object.entries(pkg.allowScripts ?? {})) {
      expect(key, key).toMatch(/^(@[^/@\s]+\/)?[^/@\s]+$/);
      expect(typeof value, key).toBe("boolean");
    }
  });

  it("has no stale entry for a package without an install script", () => {
    const stale = Object.keys(pkg.allowScripts ?? {}).filter((name) => !withScripts.includes(name));
    expect(stale).toEqual([]);
  });

  it("denies better-sqlite3's implicit node-gyp build, so its prebuilt binary is used", () => {
    expect(pkg.allowScripts?.["better-sqlite3"]).toBe(false);
  });

  it("maps nested lockfile paths to package names", () => {
    expect(packageNameOf("node_modules/tsx/node_modules/esbuild", {})).toBe("esbuild");
    expect(packageNameOf("node_modules/@sentry/cli", {})).toBe("@sentry/cli");
  });
});
