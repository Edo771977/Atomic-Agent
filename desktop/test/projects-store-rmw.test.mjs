// Issue #74 item 6: projects.json read-modify-write. A rewrite keeps the
// fields and entries this version does not know; a file that does not parse
// is read once more before it is set aside; and a change is made under a
// lock and written only while the file is still the one it was planned on.
// Built output. Run: npm run build && node --test test/projects-store-rmw.test.mjs
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../out/main/projects-store.js');

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, {recursive: true, force: true}); });
function stateDir() { const d = mkdtempSync(join(tmpdir(), 'aa-projects-rmw-')); dirs.push(d); return d; }
const file = (dir) => JSON.parse(readFileSync(P.projectsPath(dir), 'utf8'));
const put = (dir, v) => writeFileSync(P.projectsPath(dir), typeof v === 'string' ? v : JSON.stringify(v));

test('a rewrite keeps unknown top-level fields, unknown project fields and entries it cannot read', () => {
  const dir = stateDir();
  put(dir, {
    version: 1, futureTop: {x: 1},
    projects: [
      {id: 'paaaaaa1', name: 'Site', folder: '/site', instructions: '', createdAt: 1, color: 'teal', skills: ['a']},
      {id: 'pbbbbbb2', name: 'Remote one', folder: 'ssh://host/dir', instructions: '', createdAt: 2},
    ],
    chats: {s9: 'pbbbbbb2'},
  });
  const res = P.updateProjects(dir, (d) => P.assignChat(d, 's1', 'paaaaaa1'));
  assert.ok(res.ok, JSON.stringify(res));
  const f = file(dir);
  assert.deepEqual(f.futureTop, {x: 1});
  const site = f.projects.find((p) => p.id === 'paaaaaa1');
  assert.equal(site.color, 'teal');
  assert.deepEqual(site.skills, ['a']);
  assert.ok(f.projects.some((p) => p.id === 'pbbbbbb2'), 'the entry this version cannot read is kept');
  assert.equal(f.chats.s9, 'pbbbbbb2', 'and so is its chat');
  assert.equal(f.chats.s1, 'paaaaaa1');
  // What the app reads is still only what it understands.
  assert.deepEqual(P.readProjects(dir).projects.map((p) => p.id), ['paaaaaa1']);
});

test('an update changes known fields and keeps the unknown ones; a delete drops the entry and its chats', () => {
  const dir = stateDir();
  put(dir, {version: 1, projects: [{id: 'paaaaaa1', name: 'Site', folder: '/site', instructions: '', createdAt: 1, color: 'teal'}], chats: {s1: 'paaaaaa1'}});
  assert.ok(P.updateProjects(dir, (d) => P.saveProject(d, {id: 'paaaaaa1', name: 'Renamed'})).ok);
  assert.equal(file(dir).projects[0].name, 'Renamed');
  assert.equal(file(dir).projects[0].color, 'teal');
  assert.ok(P.updateProjects(dir, (d) => P.deleteProject(d, 'paaaaaa1')).ok);
  assert.deepEqual(file(dir).projects, []);
  assert.deepEqual(file(dir).chats, {});
});

test('a file that does not parse is read once more before it is set aside', () => {
  const dir = stateDir();
  put(dir, '{"version":1,"projects":[');   // another writer mid-write
  const read = P.readProjects(dir, {beforeRetry: () => put(dir, {version: 1, projects: [{id: 'paaaaaa1', name: 'Site', folder: '/site'}], chats: {}})});
  assert.deepEqual(read.projects.map((p) => p.id), ['paaaaaa1']);
  assert.ok(!readdirSync(dir).some((f) => f.includes('.bad-')), 'nothing set aside');
  // Still broken on the second read: set aside, as before.
  put(dir, '{ not json');
  assert.deepEqual(P.readProjects(dir, {beforeRetry: () => {}}), P.emptyProjects());
  assert.ok(readdirSync(dir).some((f) => f.startsWith('projects.json.bad-')));
});

test('a write that landed between the read and the write is planned on again, not overwritten', () => {
  const dir = stateDir();
  put(dir, {version: 1, projects: [{id: 'paaaaaa1', name: 'Site', folder: '/site'}, {id: 'pbbbbbb2', name: 'Two', folder: '/two'}], chats: {}});
  let calls = 0;
  const res = P.updateProjects(dir, (d) => {
    calls++;
    // The first time, another process assigns s2 meanwhile.
    if (calls === 1) put(dir, {...file(dir), chats: {s2: 'pbbbbbb2'}});
    return P.assignChat(d, 's1', 'paaaaaa1');
  });
  assert.ok(res.ok);
  assert.equal(calls, 2, 'planned again on the file as it is now');
  assert.deepEqual(file(dir).chats, {s1: 'paaaaaa1', s2: 'pbbbbbb2'});
});

test('a change waits for another writer\'s lock, and a stale lock is broken', () => {
  const dir = stateDir();
  const lock = P.projectsPath(dir) + '.lock';
  writeFileSync(lock, 'other');
  const busy = P.updateProjects(dir, (d) => P.saveProject(d, {name: 'A', folder: '/a'}), undefined, {lockWaitMs: 100});
  assert.equal(busy.ok, false, 'a held lock is not stepped over');
  assert.ok(!existsSync(P.projectsPath(dir)));
  const old = (Date.now() - 60_000) / 1000;
  utimesSync(lock, old, old);
  const res = P.updateProjects(dir, (d) => P.saveProject(d, {name: 'A', folder: '/a'}), undefined, {lockWaitMs: 100});
  assert.ok(res.ok, JSON.stringify(res));
  assert.ok(!existsSync(lock), 'the lock is released');
});
