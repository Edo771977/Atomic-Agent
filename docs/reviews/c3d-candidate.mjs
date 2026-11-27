import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
const root = resolve(process.env.C3_CANDIDATE_ROOT ?? process.cwd());
const require = createRequire(join(root, 'package.json'));
const load = p => import(pathToFileURL(join(root, 'src', p)).href);
const React = (await import(pathToFileURL(require.resolve('react')).href)).default;
const { render } = await import(pathToFileURL(require.resolve('ink-testing-library')).href);
const { CHAT_EXPORT_HINT, OnboardingImportPickStep, measureOnboardingImportPickStep } = await load('tui/onboarding/onboarding-import-step.tsx');
const { ImportFactsJobs } = await load('import/user-facts/import-facts-jobs.ts');
const { ProfileStore } = await load('memory/profile-store.ts');
const { MemoryStore } = await load('memory/memory-store.ts');
const dir = mkdtempSync(join(tmpdir(), 'c3d-onboarding-'));
const before = process.env.ATOMIC_AGENT_STATE_DIR;
process.env.ATOMIC_AGENT_STATE_DIR = dir;
after(() => { if (before === undefined) delete process.env.ATOMIC_AGENT_STATE_DIR; else process.env.ATOMIC_AGENT_STATE_DIR = before; rmSync(dir, { recursive: true, force: true }); });
const agents = [{ id: 'hermes', label: 'Hermes', dir: '~/.hermes', enabled: false }];
function show(fn) {
  const screen = render(React.createElement(OnboardingImportPickStep, { agents, cursor: 0, busy: false, error: null }));
  try { fn(screen.lastFrame() ?? ''); } finally { screen.unmount(); screen.cleanup(); }
}
test('control: onboarding names ChatGPT, Claude and the facts destination', () => show(frame => {
  assert.match(frame, /From ChatGPT or Claude\?/); assert.match(frame, /\/import › Facts about you/);
}));
test('control: layout measurement includes the entire hint', () => assert.ok(measureOnboardingImportPickStep(agents) >= CHAT_EXPORT_HINT.length));
test('control: first-run rendering starts no import and makes no memory write', () => {
  let calls = 0; const originals = [];
  for (const [type, key] of [[ImportFactsJobs, 'start'], [ProfileStore, 'set'], [MemoryStore, 'store']]) {
    originals.push([type, key, type.prototype[key]]);
    type.prototype[key] = () => { calls++; throw new Error('onboarding unexpectedly started work'); };
  }
  try { show(() => {}); assert.equal(calls, 0); assert.deepEqual(readdirSync(dir), []); }
  finally { for (const [type, key, original] of originals) type.prototype[key] = original; }
});
