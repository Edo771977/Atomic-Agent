import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const renderer = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../renderer/css/shell.css", import.meta.url), "utf8");

test("the waiting Local engine entry wraps its controls and both detail lines", () => {
  const context = vm.createContext({ esc: String });
  for (const name of ["llmCoreUpdateText", "llmCoreUpdateWaitingHTML"]) {
    const start = renderer.indexOf("function " + name + "(");
    assert.ok(start >= 0, name);
    vm.runInContext(renderer.slice(start, renderer.indexOf("\n}", start) + 2), context);
  }
  const html = context.llmCoreUpdateWaitingHTML({ targetVersion: "0.18.6", activeVersion: "0.18.5" });
  assert.match(html, /^<div class="dlc-core-waiting"><div class="dlc-top"><span class="dlc-name">Local engine<\/span><div class="dlc-core-actions">/);
  assert.match(html, /<p class="dlc-line">This reinstalls the active version\. Stop local models before updating\.<\/p>/);
  assert.match(html, /<p class="dlc-line">Target 0\.18\.6 · Active 0\.18\.5<\/p>/);
  assert.match(css, /\.dlc-core-waiting \.dlc-top\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(css, /\.dlc-core-waiting \.dlc-name\s*,\s*\.dlc-core-waiting \.dlc-line\s*\{[^}]*white-space:\s*normal[^}]*overflow:\s*visible[^}]*text-overflow:\s*clip/);
});
