import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const root = resolve(process.env.C3_CANDIDATE_ROOT ?? process.cwd());
const load = p => import(pathToFileURL(join(root, 'src/tui/import', p)).href);
const require = createRequire(join(root, 'package.json'));
const React = (await import(pathToFileURL(require.resolve('react')).href)).default;
const { render } = await import(pathToFileURL(require.resolve('ink-testing-library')).href);
const { createInitialImportFactsState } = await load('import-facts-state.ts');
const { reduceImportFacts } = await load('import-facts-reducer.ts');
const { handleImportFactsKey } = await load('import-facts-keys.ts');
const { ImportFactsView } = await load('import-facts-view.tsx');
const candidates = Array.from({ length: 12 }, (_, i) => ({ id: `c0-${i}`, kind: 'profile', key: `hobby_${i}`, value: `synthetic-value-${i}`, quote: `synthetic-quote-${i}`, chatId: 'synthetic', pinned: false }));
function found() { return reduceImportFacts({ ...createInitialImportFactsState(), phase: 'running', jobId: 'synthetic-job' }, { type: 'import_facts_found', candidates, stopped: false }); }
test('review defaults to saving no facts', () => assert.deepEqual(found().checked, []));
test('Enter without checking any fact cannot approve candidates', () => {
  const commands = [];
  handleImportFactsKey('', { return: true }, found(), () => {}, cmd => commands.push(cmd));
  assert.equal(commands.flatMap(c => c.approvedIds ?? []).length, 0);
});
test('Enter cannot save a fact absent from the only rendered review page', () => {
  const s = found(); const screen = render(React.createElement(ImportFactsView, { facts: s, maxRows: 6 }));
  try {
    const frame = screen.lastFrame() ?? ''; const commands = [];
    handleImportFactsKey('', { return: true }, s, () => {}, cmd => commands.push(cmd));
    const approved = commands.flatMap(c => c.approvedIds ?? []);
    assert.equal(candidates.filter(c => approved.includes(c.id) && !frame.includes(c.value)).length, 0);
  } finally { screen.unmount(); screen.cleanup(); }
});
test('control: a visible row displays the fact and backing quote', () => {
  const screen = render(React.createElement(ImportFactsView, { facts: found(), maxRows: 6 }));
  try { assert.match(screen.lastFrame() ?? '', /synthetic-value-0/); assert.match(screen.lastFrame() ?? '', /synthetic-quote-0/); }
  finally { screen.unmount(); screen.cleanup(); }
});
test('control: Esc discards without issuing a save', () => {
  const commands = []; handleImportFactsKey('', { escape: true }, found(), () => {}, cmd => commands.push(cmd));
  assert.deepEqual(commands, [{ kind: 'close', jobId: 'synthetic-job' }]);
});
test('control: opening a new review resets cloud consent to false', () => {
  const s = reduceImportFacts({ ...found(), cloud: true }, { type: 'import_facts_opened', localLabel: 'local', cloudProvider: 'remote' });
  assert.equal(s.cloud, false);
});
