import { describe, expect, it } from "vitest";

import { Database, loadBetterSqlite3Ctor } from "./load-better-sqlite3.js";

// better-sqlite3 >= 13 falls back to the node-gyp output path when no
// prebuilt binary matches this platform, so a missing one surfaces as this.
const bindingsError = () =>
  new Error("Cannot find module 'C:\\x\\node_modules\\better-sqlite3\\build\\Release\\better_sqlite3.node'");

function failingRequire(err: Error): (id: string) => unknown {
  return () => {
    throw err;
  };
}

describe("loadBetterSqlite3Ctor", () => {
  it("turns a missing native binding into an actionable error from source", () => {
    const raw = bindingsError();
    let thrown: unknown;
    try {
      loadBetterSqlite3Ctor({ req: failingRequire(raw), sea: false, abi: "141", platform: "win32" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const err = thrown as Error;
    expect(err.message).toContain("better-sqlite3");
    expect(err.message).toContain("ABI 141");
    expect(err.message).toContain("npm ci");
    expect(err.message).toContain("npx node-gyp rebuild --release --directory node_modules/better-sqlite3");
    expect(err.message).not.toContain("npm rebuild better-sqlite3");
    expect(err.message).toContain("Visual Studio Build Tools");
    expect(err.message).toContain("Python 3");
    expect(err.cause).toBe(raw);
  });

  it("omits the Windows toolchain hint on other platforms", () => {
    const err = (() => {
      try {
        loadBetterSqlite3Ctor({ req: failingRequire(bindingsError()), sea: false, abi: "141", platform: "linux" });
      } catch (e) {
        return e as Error;
      }
      throw new Error("expected a throw");
    })();
    expect(err.message).toContain("npx node-gyp rebuild");
    expect(err.message).not.toContain("Visual Studio");
  });

  it("recognises an ABI mismatch", () => {
    const raw = new Error("The module was compiled against a different Node.js version using NODE_MODULE_VERSION 127. This version of Node.js requires NODE_MODULE_VERSION 141.");
    expect(() => loadBetterSqlite3Ctor({ req: failingRequire(raw), sea: false, abi: "141", platform: "darwin" }))
      .toThrow(/ABI 141[\s\S]*npm ci/);
  });

  it("tells an installed (SEA) build to reinstall instead of rebuilding", () => {
    const raw = bindingsError();
    let err: Error | undefined;
    try {
      loadBetterSqlite3Ctor({ req: failingRequire(raw), sea: true, abi: "141", platform: "win32" });
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).toContain("reinstall atomic-agent");
    expect(err?.message).not.toContain("npm ci");
    expect(err?.cause).toBe(raw);
  });

  it.each([
    ["Windows, a binding that cannot be loaded", "\\\\?\\C:\\x\\node_modules\\better-sqlite3\\build\\Release\\better_sqlite3.node: The specified module could not be found."],
    ["Linux, a binding built against a newer glibc", "/lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.38' not found (required by /x/node_modules/better-sqlite3/build/Release/better_sqlite3.node)"],
  ])("recognises %s (#29 review)", (_name, message) => {
    expect(() => loadBetterSqlite3Ctor({ req: failingRequire(new Error(message)), sea: false, abi: "141", platform: "linux" }))
      .toThrow(/ABI 141[\s\S]*npm ci/);
  });

  it("passes an unrelated missing module through unchanged", () => {
    const raw = new Error("Cannot find module 'node-addon-api'");
    expect(() => loadBetterSqlite3Ctor({ req: failingRequire(raw), sea: false })).toThrow(raw);
  });

  it("passes other errors through unchanged", () => {
    const raw = new Error("EACCES: permission denied");
    expect(() => loadBetterSqlite3Ctor({ req: failingRequire(raw), sea: false })).toThrow(raw);
  });

  it("returns the module when it loads", () => {
    const ctor = function FakeDb() {};
    expect(loadBetterSqlite3Ctor({ req: () => ctor, sea: false })).toBe(ctor);
  });

  it("still opens a real in-memory database", () => {
    const db = new Database(":memory:");
    expect(db.prepare("select 1 as one").get()).toEqual({ one: 1 });
    db.close();
  });
});
