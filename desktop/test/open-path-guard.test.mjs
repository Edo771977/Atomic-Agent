// Issue #74 item 4: more file types that Windows (and macOS) run, mount or
// install when opened are revealed instead, and the open/stat/file-menu IPCs
// refuse a Windows network path (`\\host\share`), as replyPathVerdict does.
// Built output. Run: npm run build && node --test test/open-path-guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runsWhenOpened, localPathArg } = require('../out/main/reply-paths.js');

const WINDOWS = ['.library-ms', '.searchConnector-ms', '.settingcontent-ms', '.iso', '.img', '.vhd', '.vhdx',
  '.xll', '.wsb', '.ps1xml', '.mht', '.mhtml', '.xbap'];
const MACOS = ['.mobileconfig', '.configprofile'];

for (const ext of WINDOWS) {
  test(`a ${ext} file is revealed, not opened, on Windows`, () => {
    assert.equal(runsWhenOpened('win32', 'C:\\Users\\a\\x' + ext, 'file', 0), true);
    assert.equal(runsWhenOpened('win32', 'C:\\Users\\a\\X' + ext.toUpperCase(), 'file', 0), true);
  });
}
for (const ext of MACOS) {
  test(`a ${ext} file is revealed, not opened, on macOS`, () => {
    assert.equal(runsWhenOpened('darwin', '/Users/a/x' + ext, 'file', 0o644), true);
  });
}

test('an ordinary document is still opened', () => {
  assert.equal(runsWhenOpened('win32', 'C:\\Users\\a\\notes.txt', 'file', 0), false);
  assert.equal(runsWhenOpened('darwin', '/Users/a/report.pdf', 'file', 0o644), false);
});

test('a Windows network or device path is not a path to open, stat or show', () => {
  for (const p of ['\\\\evil.example\\share\\a.txt', '//evil.example/share/a.txt', '\\\\?\\C:\\x.txt', '\\\\.\\pipe\\x', '\\/host/share']) {
    assert.equal(localPathArg('win32', p), null, p);
  }
  assert.equal(localPathArg('win32', 'C:\\Users\\a\\notes.txt'), 'C:\\Users\\a\\notes.txt');
  assert.equal(localPathArg('win32', 'relative\\x'), null);
  assert.equal(localPathArg('darwin', '/Users/a/notes.txt'), '/Users/a/notes.txt');
  assert.equal(localPathArg('linux', '/home/a/x\0y'), null);
  assert.equal(localPathArg('linux', 42), null);
});
