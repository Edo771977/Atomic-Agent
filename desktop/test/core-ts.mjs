// Loads a module of the agent's own source (src/**/*.ts) into a Node test
// without an agent build: TypeScript transpiles each file to CommonJS and
// only relative imports are followed (type-only ones vanish). For pure
// core logic the desktop must agree with, as provider-model-mode.test.mjs does.
// The only builtins allowed are node:path (pure string work, used by
// session-project.ts for attachment paths) and node:net (its pure `isIP`,
// used by offline-network.ts isLoopbackHost); `process` is a minimal shim
// with the host's platform and an EMPTY env, so no core default can depend
// on the machine's environment variables.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const modules = new Map();
const BUILTINS = new Set(['node:path', 'node:net']);
const processShim = Object.freeze({ platform: process.platform, env: Object.freeze({}) });

// `extra`: builtins one caller allows on top (folder-constraint.test.mjs: node:fs,
// for the core's default real path and worktree reads, which it also replaces with fakes).
export function loadCore(url, extra = []) {
  if (modules.has(url.href)) return modules.get(url.href);
  const exports = {};
  modules.set(url.href, exports);
  const { outputText } = ts.transpileModule(readFileSync(url, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  runInNewContext(outputText, {
    exports, URL, Math, Number, String, Array, Object, JSON, Set, Map, process: processShim,
    require: (specifier) => {
      if (BUILTINS.has(specifier) || extra.includes(specifier)) return require(specifier);
      assert.ok(specifier.startsWith('.'), `unexpected core dependency: ${specifier}`);
      return loadCore(new URL(specifier.replace(/\.js$/, '.ts'), url), extra);
    },
  }, { filename: url.pathname });
  return exports;
}
