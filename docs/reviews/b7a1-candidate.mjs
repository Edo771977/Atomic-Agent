// Run with node --test docs/reviews/b7a1-candidate.mjs. No production files are changed.
import { execFileSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const source = execFileSync('git', ['show', '--no-textconv', '1570a8140c53f2d987ca813dd1fa9a8542ab6ccc:src/memory/evolution/memory-restore.ts'], {encoding:'utf8'});
// Execute the complete candidate restore owner with only its imported name-key predicate stubbed.
const body = source.replace(/^import[\s\S]*?from\s+"[^"]+";\r?\n/gm, '').replaceAll('export ', '');
const context = vm.createContext({ isNameProfileKey: () => false });
vm.runInContext(stripTypeScriptTypes(body) + '\nglobalThis.restore = restoreMemoryChange;', context);
const scope = JSON.stringify({key:'private-folder',allowedProviders:['local'],allowedEgress:[]});
function run(extra = {}) {
  let restored;
  let marked = false;
  const before = {id:1,content:'kept',tags:[],constraintScope:scope,disabledAt:123,
    absorbed:{content:'folded sentinel',tags:[],source:'agent',sessionId:'ordinary',workingDir:'private-folder',at:1,constraintScope:scope,disabledAt:123}};
  const change = {id:1,kind:'note',op:'merge',target:'1',by:'agent',restoredAt:null,before};
  const notes = {getChangeLog:()=>({get:()=>change,markRestored:()=>{marked=true;}}),setTags:()=>true,
    restoreNote:snapshot=>{restored=snapshot;return snapshot;}};
  context.restore(1,{notes,profile:{},...extra},2);
  return {restored,marked};
}
test('merge restore retains the absorbed constraint scope',()=>assert.equal(run().restored.constraintScope,scope));
test('merge restore retains disabled state',()=>assert.equal(run().restored.disabledAt,123));
test('disabled memory performs no restoration',()=>assert.equal(run({memoryEnabled:false}).restored,undefined));
