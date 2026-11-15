# Native dependency loading

Status: current
Owner: src/native/

Loads externally shipped native/runtime dependencies. Preserve deployment fallback paths for better-sqlite3 and playwright-core.

better-sqlite3 (13.x) is N-API and ships one prebuilt binary per supported platform in `prebuilds/`, so it has no install script and serves every Node major; it loads a locally compiled `build/Release/better_sqlite3.node` first when one exists, else the prebuilt one. package.json `allowScripts` denies its implicit `node-gyp rebuild` (npm 12 reports one because of its `binding.gyp`). `atomic-agent doctor`'s sqlite check names the versions and the binding it loaded. A load that fails because the native binding is missing or unloadable (`Cannot find module '…better_sqlite3.node'`, the pre-13 `Could not locate the bindings file`/`NODE_MODULE_VERSION`/`was compiled against` forms of a stale local build, Windows' `The specified module could not be found`, Linux' `GLIBC_… not found`) is rethrown with the fix and the original as `cause`: from source `npm ci`, or on a platform without a prebuilt binary `npx node-gyp rebuild --release --directory node_modules/better-sqlite3` (on Windows with Visual Studio Build Tools' C++ workload and Python 3), and under the installed single-executable build "reinstall atomic-agent". Other load errors pass through unchanged. `atomic-agent doctor` reports it as the `sqlite` check.

Entry point: [index.ts](index.ts). Read the root instruction route and the underlying domain instructions before cross-domain changes.

Checks: `npx vitest run src/native` when tests are present; `npm run lint`; `npm run docs:check`.
