// Memory tab and per-folder constraints (issue #33): the tab reads
// memory.sqlite directly and so lists notes and facts written under a
// folder constraint (their `constraint_scope` column), but the agent's
// /api/memory routes carry no folder policy and see only unscoped rows: an
// edit or delete of a scoped row answered 404 ("gone") while the row stayed.
// Such rows are marked and read-only in the tab. Main half from the built
// output: npm run build first.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const { memoryQuery } = require('../out/main/memory-db.js');
const E = require('../renderer/memory-edit.js');

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function stateDir({ withScope }) {
  const dir = mkdtempSync(join(tmpdir(), 'memory-scoped-'));
  dirs.push(dir);
  const db = new DatabaseSync(join(dir, 'memory.sqlite'));
  const scope = withScope ? ', constraint_scope TEXT' : '';
  db.exec(`CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, session_id TEXT,
    working_dir TEXT, tags TEXT, recall_count INTEGER, last_recalled_at INTEGER, consolidated_into INTEGER${scope})`);
  db.exec(`CREATE TABLE profile_facts (id INTEGER PRIMARY KEY, key TEXT, value TEXT, pinned INTEGER, keywords TEXT, valid_from INTEGER,
    superseded_by INTEGER, supersedes INTEGER, created_at INTEGER, updated_at INTEGER, vote_score INTEGER${scope})`);
  const desc = JSON.stringify({ key: '/work/secret', allowedProviders: ['local-llama'], allowedEgress: [] });
  if (withScope) {
    db.prepare(`INSERT INTO memories (id, content, created_at, updated_at, tags, consolidated_into, constraint_scope) VALUES (?, ?, 1, ?, '[]', NULL, ?)`).run(1, 'open note', 1, null);
    db.prepare(`INSERT INTO memories (id, content, created_at, updated_at, tags, consolidated_into, constraint_scope) VALUES (?, ?, 1, ?, '[]', NULL, ?)`).run(2, 'merger note', 2, desc);
    db.prepare(`INSERT INTO profile_facts (id, key, value, pinned, keywords, valid_from, superseded_by, created_at, updated_at, vote_score, constraint_scope) VALUES (1, 'client', 'acme', 0, '[]', 1, NULL, 1, 1, 0, ?)`).run(desc);
  } else {
    db.prepare(`INSERT INTO memories (id, content, created_at, updated_at, tags) VALUES (1, 'old note', 1, 1, '[]')`).run();
    db.prepare(`INSERT INTO profile_facts (id, key, value, pinned, keywords, valid_from, superseded_by, created_at, updated_at, vote_score) VALUES (1, 'name', 'Ann', 0, '[]', 1, NULL, 1, 1, 0)`).run();
  }
  db.close();
  return dir;
}

test('note and fact rows say whether they are kept for a restricted folder', async () => {
  const dir = stateDir({ withScope: true });
  const list = await memoryQuery(dir, 'notes.listActive', [50]);
  assert.equal(list.ok, true, list.error);
  const byId = Object.fromEntries(list.rows.map((r) => [r.id, r]));
  assert.equal(E.memScopedRow(byId[1]), false);
  assert.equal(E.memScopedRow(byId[2]), true);
  assert.equal('constraint_scope' in byId[2], false, 'the descriptor itself is not handed to the window');
  assert.equal(E.memScopedRow((await memoryQuery(dir, 'notes.get', [2])).rows[0]), true);
  assert.equal(E.memScopedRow((await memoryQuery(dir, 'notes.listAll', [50])).rows.find((r) => r.id === 2)), true);
  assert.equal(E.memScopedRow((await memoryQuery(dir, 'profile.list', [])).rows[0]), true);
  assert.equal(E.memScopedRow((await memoryQuery(dir, 'profile.history', ['client'])).rows[0]), true);
});

test('a memory.sqlite from before scopes still lists, every row unscoped', async () => {
  const dir = stateDir({ withScope: false });
  const list = await memoryQuery(dir, 'notes.listActive', [50]);
  assert.equal(list.ok, true, list.error);
  assert.equal(list.rows.length, 1);
  assert.equal(E.memScopedRow(list.rows[0]), false);
  const facts = await memoryQuery(dir, 'profile.list', []);
  assert.equal(facts.ok, true, facts.error);
  assert.equal(E.memScopedRow(facts.rows[0]), false);
});

test('a scoped note or fact page is read-only, with the reason', () => {
  assert.equal(E.memEditKey({ channel: 'notes', id: 2, scoped: true }), null);
  assert.equal(E.memEditKey({ channel: 'profile', key: 'client', scoped: true }), null);
  assert.equal(E.memEditKey({ channel: 'notes', id: 1, scoped: false }), 'note:1');
  assert.match(E.MEM_SCOPED_REASON, /kept for a restricted folder; manage it from that folder/i);
});

test('the tab carries the mark from the rows to the list and the page', () => {
  const src = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  for (const hook of ['scoped:memScopedRow(r)', 'scoped:memScopedRow(rows[0])', 'scoped:chainRows.some(']) {
    assert.ok(src.includes(hook), hook);
  }
});
