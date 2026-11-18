// Issue #74 review: a stale projects.json.lock that cannot be removed
// (EPERM/EBUSY from an antivirus or indexer on Windows, a foreign owner, a
// read-only file system) must not spin Electron's main thread for ever: the
// change gives up after its wait with the "another window" answer.
// Built output. Run: npm run build && node --test test/projects-lock-stuck.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const store = fileURLToPath(new URL('../out/main/projects-store.js', import.meta.url));

const child = `
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-lock-stuck-'));
const P = require(${JSON.stringify(store)});
const lock = P.projectsPath(dir) + '.lock';
fs.writeFileSync(lock, 'crashed');
const old = (Date.now() - 60000) / 1000;
fs.utimesSync(lock, old, old);
const real = { unlinkSync: fs.unlinkSync, renameSync: fs.renameSync };
const refuse = (p) => { if (String(p).includes('.lock')) { const e = new Error('EPERM: operation not permitted'); e.code = 'EPERM'; throw e; } };
fs.unlinkSync = (p, ...r) => { refuse(p); return real.unlinkSync(p, ...r); };
fs.renameSync = (a, b, ...r) => { refuse(a); return real.renameSync(a, b, ...r); };
const t0 = Date.now();
const res = P.updateProjects(dir, (d) => P.saveProject(d, { name: 'A', folder: '/a' }), undefined, { lockWaitMs: 200 });
process.stdout.write(JSON.stringify({ ok: res.ok, error: res.error, ms: Date.now() - t0, file: fs.existsSync(P.projectsPath(dir)) }));
`;

test('a stale lock that cannot be removed ends in an answer, not a hang', () => {
  const r = spawnSync(process.execPath, ['-e', child], { encoding: 'utf8', timeout: 5000 });
  assert.notEqual(r.signal, 'SIGTERM', 'updateProjects did not return within 5 s (spinning on the lock)');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, false);
  assert.match(out.error, /another window/);
  assert.equal(out.file, false, 'nothing written without the lock');
  assert.ok(out.ms < 2000, `gave up after ${out.ms} ms`);
});
