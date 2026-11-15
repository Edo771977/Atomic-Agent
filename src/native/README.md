# Native dependency loading

Status: current
Owner: src/native/

Loads externally shipped native/runtime dependencies. Preserve deployment fallback paths for better-sqlite3 and playwright-core.

A better-sqlite3 load that fails because the native binding is missing or built for another Node ABI (`Could not locate the bindings file`, `NODE_MODULE_VERSION`, `was compiled against`, Windows' `The specified module could not be found`, Linux' `GLIBC_… not found`) is rethrown with the fix and the original as `cause`: from source `npm rebuild better-sqlite3 --foreground-scripts` (on Windows with Visual Studio Build Tools' C++ workload and Python 3), and under the installed single-executable build "reinstall atomic-agent". Other load errors pass through unchanged. `atomic-agent doctor` reports it as the `sqlite` check.

Entry point: [index.ts](index.ts). Read the root instruction route and the underlying domain instructions before cross-domain changes.

Checks: `npx vitest run src/native` when tests are present; `npm run lint`; `npm run docs:check`.
