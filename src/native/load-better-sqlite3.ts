/**
 * Lazy loader for `better-sqlite3` that works both in development and inside
 * a Node SEA binary built with `"mainFormat": "module"`.
 *
 * SEA's ESM entry point cannot resolve non-builtin specifiers via static
 * `import` (`ERR_UNKNOWN_BUILTIN_MODULE`), so we route the load through CJS
 * `createRequire` anchored at the executable's directory. The installer
 * ships `node_modules/better-sqlite3` (plus its runtime deps `bindings` and
 * `file-uri-to-path`) alongside the binary so that `createRequire` finds
 * them through the normal Node module resolution.
 *
 * Consumers import the named `Database` value from this module for the
 * runtime constructor. Type references like `BetterSqlite3.Database` or
 * `BetterSqlite3.Statement` keep coming from `better-sqlite3` directly via
 * `import type`, which is erased at build time and therefore has no
 * runtime resolution cost under SEA.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { execPath } from "node:process";
import type BetterSqlite3 from "better-sqlite3";

type DatabaseCtor = typeof BetterSqlite3;

// `node:sea` is a newish built-in and Vite's module graph can't resolve it
// at static import time (tests fail with "Failed to load url sea"). Load it
// dynamically via `createRequire`; in non-SEA contexts the call simply
// fails and we fall back to dev-mode resolution.
const bootRequire = createRequire(import.meta.url);

function isRunningUnderSea(): boolean {
  try {
    const sea: typeof import("node:sea") = bootRequire("node:sea");
    return sea.isSea();
  } catch {
    return false;
  }
}

let cached: DatabaseCtor | null = null;

/** The raw errors `bindings`/Node give for a missing or wrong-ABI `.node` file. */
const NATIVE_BINDING_ERROR = /Could not locate the bindings file|NODE_MODULE_VERSION|was compiled against/;

export interface LoadBetterSqlite3Deps {
  req: (id: string) => unknown;
  /** Running as the installed single-executable build. */
  sea: boolean;
  /** Node's native module ABI (`process.versions.modules`). */
  abi?: string;
  platform?: NodeJS.Platform;
}

/**
 * Loads the module, and turns a missing or mismatched native binding (an
 * install script that never ran, e.g. npm blocking it, or a Node upgrade)
 * into an error that says how to fix it. The original stays as `cause`.
 */
export function loadBetterSqlite3Ctor(deps: LoadBetterSqlite3Deps): DatabaseCtor {
  try {
    return deps.req("better-sqlite3") as DatabaseCtor;
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    if (!NATIVE_BINDING_ERROR.test(raw)) throw err;
    const abi = deps.abi ?? process.versions.modules;
    const head = `better-sqlite3's native binding is missing or was built for another Node version (this Node needs ABI ${abi}).`;
    let fix: string;
    if (deps.sea) {
      fix = "The installed files are incomplete or from another release: reinstall atomic-agent.";
    } else {
      fix = "From source, build it for this Node: npm rebuild better-sqlite3 --foreground-scripts";
      if ((deps.platform ?? process.platform) === "win32") {
        fix += " (on Windows this needs Visual Studio Build Tools with the \"Desktop development with C++\" (VCTools) workload, and Python 3).";
      } else {
        fix += " (this needs a C++ toolchain and Python 3).";
      }
      fix += " If npm blocked the package's install script, allow it and run the rebuild again.";
    }
    throw new Error(`${head} ${fix}`, { cause: err });
  }
}

function resolveCtor(): DatabaseCtor {
  if (cached) return cached;

  let req: NodeRequire;
  const sea = isRunningUnderSea();
  if (sea) {
    // The anchor file does not need to exist; `createRequire` only uses
    // it as the resolution root for `node_modules` lookups.
    const anchor = join(dirname(execPath), "__atomic_sea_anchor__.js");
    req = createRequire(anchor);
  } else {
    req = createRequire(import.meta.url);
  }
  cached = loadBetterSqlite3Ctor({ req, sea });
  return cached;
}

const DatabaseProxy = new Proxy(function () {} as unknown as DatabaseCtor, {
  apply(_target, _thisArg, args: ConstructorParameters<DatabaseCtor>) {
    return new (resolveCtor())(...args);
  },
  construct(_target, args: ConstructorParameters<DatabaseCtor>) {
    return new (resolveCtor())(...args);
  },
  get(_target, prop, receiver) {
    return Reflect.get(resolveCtor(), prop, receiver);
  },
  has(_target, prop) {
    return Reflect.has(resolveCtor(), prop);
  },
}) as DatabaseCtor;

export const Database: DatabaseCtor = DatabaseProxy;
