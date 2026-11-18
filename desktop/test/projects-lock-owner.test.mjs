// Issue #74 review: breaking a stale projects.json.lock must not remove a
// fresh lock another writer took meanwhile, and releasing must remove only
// our own lock. Each case runs in a child, where node:fs is patched to
// stage the race.
// Built output. Run: npm run build && node --test test/projects-lock-owner.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const store = fileURLToPath(new URL('../out/main/projects-store.js', import.meta.url));
const head = `
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-lock-owner-'));
const P = require(${JSON.stringify(store)});
const lock = P.projectsPath(dir) + '.lock';
const out = (v) => { process.stdout.write(JSON.stringify(v)); fs.rmSync(dir, { recursive: true, force: true }); };
`;
const run = (body) => {
  const r = spawnSync(process.execPath, ['-e', head + body], {encoding: 'utf8', timeout: 5000});
  assert.equal(r.status, 0, r.stderr || String(r.signal));
  return JSON.parse(r.stdout);
};

test('a stale lock replaced by a fresh one before it is broken is left to its new owner', () => {
  const o = run(`
    fs.writeFileSync(lock, 'crashed');
    const old = (Date.now() - 60000) / 1000;
    fs.utimesSync(lock, old, old);
    // Between our look at the stale lock and our break of it, writer A breaks it and takes a fresh one.
    const realStat = fs.statSync;
    let staged = false;
    fs.statSync = (p, ...r) => {
      const st = realStat(p, ...r);
      if (!staged && String(p) === lock) { staged = true; fs.unlinkSync(lock); fs.writeFileSync(lock, 'A-token'); }
      return st;
    };
    const res = P.updateProjects(dir, (d) => P.saveProject(d, { name: 'B', folder: '/b' }), undefined, { lockWaitMs: 150 });
    out({ ok: res.ok, lock: fs.existsSync(lock) ? fs.readFileSync(lock, 'utf8') : null, wrote: fs.existsSync(P.projectsPath(dir)) });
  `);
  assert.equal(o.lock, 'A-token', "A's fresh lock is still there");
  assert.equal(o.ok, false, 'B waited for A instead of taking the lock');
  assert.equal(o.wrote, false);
});

test('releasing removes only our own lock', () => {
  const o = run(`
    const res = P.updateProjects(dir, (d) => {
      // Our lock was broken (taken for stale) and another writer holds it now.
      fs.writeFileSync(lock, 'other-token');
      return P.saveProject(d, { name: 'B', folder: '/b' });
    });
    out({ ok: res.ok, lock: fs.existsSync(lock) ? fs.readFileSync(lock, 'utf8') : null });
  `);
  assert.equal(o.lock, 'other-token', "the other writer's lock is not removed");
});

test('an ordinary change takes and releases the lock, and no stale-lock leftovers stay', () => {
  const o = run(`
    const res = P.updateProjects(dir, (d) => P.saveProject(d, { name: 'B', folder: '/b' }));
    fs.writeFileSync(lock, 'crashed');
    const old = (Date.now() - 60000) / 1000;
    fs.utimesSync(lock, old, old);
    const again = P.updateProjects(dir, (d) => P.saveProject(d, { name: 'C', folder: '/c' }));
    out({ ok: res.ok && again.ok, files: fs.readdirSync(dir).sort() });
  `);
  assert.equal(o.ok, true);
  assert.deepEqual(o.files, ['projects.json']);
});
