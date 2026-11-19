// The window loads every renderer script as a classic <script>, in
// index.html order, into one global scope. A top-level `const`/`let`/`class`
// declared by two of them is a SyntaxError for the second, which then never
// runs at all (issue: fusion-reviewer.js and fusion-reasoning.js both
// declared `FZR`, so worker reasoning, Settings and the project card broke).
// Unit tests load one module at a time and cannot see that, so this test
// instantiates the real scripts together, in the real order.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const RENDERER = join(dirname(fileURLToPath(import.meta.url)), "..", "renderer");

function scriptsInOrder() {
  const html = readFileSync(join(RENDERER, "index.html"), "utf8");
  return [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]).filter((src) => !/^(https?:)?\/\//.test(src));
}

test("every renderer script loads in index.html order without redeclaring another's top-level name", () => {
  const scripts = scriptsInOrder();
  assert.ok(scripts.length > 5, "index.html lists the renderer scripts");
  // A bare context: the scripts may throw at run time for want of the DOM,
  // which is not what this test checks. A redeclaration is a SyntaxError at
  // instantiation, before any of the script's own code runs.
  const context = vm.createContext({});
  const clashes = [];
  for (const src of scripts) {
    const code = readFileSync(join(RENDERER, src), "utf8");
    const script = new vm.Script(code, { filename: src });
    try {
      script.runInContext(context, { timeout: 2000 });
    } catch (err) {
      if (err && err.name === "SyntaxError") clashes.push(`${src}: ${err.message}`);
    }
  }
  assert.deepEqual(clashes, [], "a renderer script redeclares a name another one already declared");
});

// Two top-level `function` declarations with one name are not an error in
// classic scripts: the later script silently replaces the earlier one's
// function for every caller (fusion-reasoning.js's fzrRowHTML/fzrRepaint
// replaced the Reviewer seat's). Each top-level function name belongs to
// one script.
test("no two renderer scripts declare a top-level function with the same name", () => {
  const owners = new Map();
  for (const src of scriptsInOrder()) {
    const code = readFileSync(join(RENDERER, src), "utf8");
    for (const m of code.matchAll(/^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm)) {
      const list = owners.get(m[1]) ?? new Set();
      list.add(src);
      owners.set(m[1], list);
    }
  }
  const shared = [...owners].filter(([, files]) => files.size > 1).map(([name, files]) => `${name}: ${[...files].join(", ")}`);
  assert.deepEqual(shared, [], "a top-level function name is declared by more than one renderer script");
});
