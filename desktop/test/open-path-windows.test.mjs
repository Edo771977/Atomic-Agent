// Review of #74: the Windows path rules of app:openPath / app:statPaths /
// app:fileMenu (localPathCheck in reply-paths.ts). A long path `\\?\C:\…` is
// a local path; a network path is accepted only inside the chat's working
// folder when that folder is itself on a share; device paths never; and
// statPaths reports a refused path instead of dropping it.
// Built output. Run: npm run build && node --test test/open-path-windows.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { localPathCheck, localPathArg } = require('../out/main/reply-paths.js');

test('a long path \\\\?\\C:\\… is the local path C:\\…', () => {
  assert.deepEqual(localPathCheck('win32', '\\\\?\\C:\\Users\\a\\report.pdf'), {ok: true, path: 'C:\\Users\\a\\report.pdf'});
  assert.equal(localPathArg('win32', '//?/D:/x.txt'), 'D:/x.txt');
});

test('a network path is refused, with the reason', () => {
  assert.deepEqual(localPathCheck('win32', '\\\\evil.example\\share\\a.txt'), {ok: false, why: 'network-path'});
  assert.deepEqual(localPathCheck('win32', '\\\\?\\UNC\\evil.example\\share\\a.txt'), {ok: false, why: 'network-path'});
  assert.deepEqual(localPathCheck('win32', '//evil.example/share/a.txt'), {ok: false, why: 'network-path'});
});

test('a network path inside the working folder on a share is accepted', () => {
  const roots = ['\\\\nas\\team\\proj'];
  assert.deepEqual(localPathCheck('win32', '\\\\nas\\team\\proj\\out\\a.txt', roots), {ok: true, path: '\\\\nas\\team\\proj\\out\\a.txt'});
  assert.deepEqual(localPathCheck('win32', '\\\\?\\UNC\\nas\\team\\proj\\a.txt', roots), {ok: true, path: '\\\\nas\\team\\proj\\a.txt'});
  assert.deepEqual(localPathCheck('win32', '//NAS/team/proj/b.txt', roots).ok, true, 'case and separators as Windows reads them');
  // Outside it, or climbing out of it, or another host: refused.
  assert.equal(localPathCheck('win32', '\\\\nas\\team\\other\\a.txt', roots).ok, false);
  assert.equal(localPathCheck('win32', '\\\\nas\\team\\proj\\..\\other\\a.txt', roots).ok, false);
  assert.equal(localPathCheck('win32', '\\\\evil\\team\\proj\\a.txt', roots).ok, false);
  // A local working folder allows no share.
  assert.equal(localPathCheck('win32', '\\\\nas\\team\\proj\\a.txt', ['C:\\Users\\a\\proj']).ok, false);
});

test('device paths are never accepted', () => {
  for (const p of ['\\\\.\\pipe\\x', '\\\\.\\C:\\x.txt', '\\\\?\\GLOBALROOT\\Device\\x', '\\\\?\\Volume{0}\\x']) {
    assert.deepEqual(localPathCheck('win32', p, ['\\\\nas\\team']), {ok: false, why: 'device-path'}, p);
  }
});

test('other platforms are unchanged', () => {
  assert.deepEqual(localPathCheck('linux', '/home/a/x'), {ok: true, path: '/home/a/x'});
  assert.deepEqual(localPathCheck('darwin', 'rel/x'), {ok: false, why: 'not-a-path'});
  assert.deepEqual(localPathCheck('linux', 7), {ok: false, why: 'not-a-path'});
});

test('main.ts: statPaths reports a refused path, and the share rule uses the working folder', () => {
  const main = readFileSync(new URL('../main/main.ts', import.meta.url), 'utf8');
  assert.match(main, /refused: checked\.why/);
  assert.match(main, /localPathCheck\(process\.platform, p, \[client\.status\.workingDir\]\)/);
});
