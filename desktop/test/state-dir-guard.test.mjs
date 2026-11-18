// Issue #74 item 2: the state-dir argument guard (main.ts ownDir) is not a
// string prefix. `<state>/../victim` and a symlink out of the state dir are
// refused; the handlers are handed the desktop's own directory, never the
// renderer's string.
// Built output. Run: npm run build && node --test test/state-dir-guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const root = mkdtempSync(join(tmpdir(), 'sd-guard-'));
const state = join(root, 'state');
mkdirSync(state);
mkdirSync(join(root, 'victim'));
symlinkSync(join(root, 'victim'), join(state, 'out-link'));
process.env.ATOMIC_AGENT_STATE_DIR = state;
const require = createRequire(import.meta.url);
const { DESKTOP_STATE_DIR, underDesktopState, desktopStateDirArg } = require('../out/main/state-dir.js');

test('a `..` out of the state dir is not under it', () => {
  assert.equal(DESKTOP_STATE_DIR, state);
  assert.equal(underDesktopState(state + '/../victim'), false);
  assert.equal(underDesktopState(state + '/sub/../../victim'), false);
  assert.equal(underDesktopState(state + '/..'), false);
});

test('a symlink inside the state dir that leads out of it is not under it', () => {
  assert.equal(underDesktopState(join(state, 'out-link')), false);
  assert.equal(underDesktopState(join(state, 'out-link', 'x')), false);
});

test('the state dir itself, and paths inside it (existing or not), still are', () => {
  assert.equal(underDesktopState(state), true);
  assert.equal(underDesktopState(state + '/'), true);
  assert.equal(underDesktopState(join(state, 'traces')), true);
  assert.equal(underDesktopState(state + '/a/../traces'), true);
  assert.equal(underDesktopState(realpathSync(state)), true);
  assert.equal(underDesktopState('relative/path'), false);
  assert.equal(underDesktopState(42), false);
});

test('a handler argument names the state dir itself, and is replaced by DESKTOP_STATE_DIR', () => {
  assert.equal(desktopStateDirArg(state), DESKTOP_STATE_DIR);
  assert.equal(desktopStateDirArg(state + '/'), DESKTOP_STATE_DIR);
  assert.equal(desktopStateDirArg(join(state, 'sub', '..')), DESKTOP_STATE_DIR);
  assert.equal(desktopStateDirArg(state + '/../victim'), null);
  assert.equal(desktopStateDirArg(join(state, 'out-link')), null);
  assert.equal(desktopStateDirArg(join(state, 'traces')), null);
  assert.equal(desktopStateDirArg(null), null);
});
