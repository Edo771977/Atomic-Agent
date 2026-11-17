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
import vm from 'node:vm';
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

/* The memory tab's own row and page builders, lifted out of renderer.js by
   name and run in a context with memory-edit.js and a stub memQ over the
   statements main answers (memoryQuery on the fixture database). */
function memoryTab(dir) {
  const src = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  const fn = (name) => {
    const m = new RegExp('^(?:async )?function ' + name + '\\(', 'm').exec(src);
    assert.ok(m, 'renderer.js has ' + name);
    const rest = src.slice(m.index + 1);
    return src.slice(m.index, m.index + 1 + rest.search(/\n(?:async )?function |\n(?:const|let|var) |\n\/\*/));
  };
  const names = ['memParseJsonList', 'memTrunc', 'renderNotePreview', 'memTagsMeta', 'memVote', 'memFact', 'memNoteEntry', 'memRowsNotes',
    'memRowsProfile', 'memLink', 'formatNoteDetailBody', 'formatLinkSection', 'formatProfileHistoryBody', 'memTruncateDetail', 'memNoteDetail', 'memBuildDetail'];
  const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
  const ctx = vm.createContext({
    esc, ic: (n) => '<i:' + n + '>', render: () => {}, BR: {},
    memFlag: () => false,
    memQ: async (name, params) => { const r = await memoryQuery(dir, name, params); if (!r.ok) throw new Error(r.error); return r.rows; },
  });
  vm.runInContext(readFileSync(new URL('../renderer/memory-edit.js', import.meta.url), 'utf8'), ctx);
  const limit = /^const MEM_MAX_DETAIL_CHARS = .*$/m.exec(src);
  assert.ok(limit, 'renderer.js has MEM_MAX_DETAIL_CHARS');
  vm.runInContext(limit[0] + '\n' + names.map(fn).join('\n') + '\n;globalThis.T = {memRowsNotes, memRowsProfile, memBuildDetail};', ctx);
  return {T: ctx.T, buttons: (d) => vm.runInContext('memEditButtonsHTML', ctx)(d)};
}

test('the tab marks the rows, and a scoped page has the reason and no Edit or Delete', async () => {
  const dir = stateDir({ withScope: true });
  const {T, buttons} = memoryTab(dir);
  const notes = T.memRowsNotes((await memoryQuery(dir, 'notes.listActive', [50])).rows);
  assert.deepEqual(notes.map((r) => [r.numericId, r.scoped]).sort(), [[1, false], [2, true]]);
  const facts = T.memRowsProfile((await memoryQuery(dir, 'profile.list', [])).rows);
  assert.equal(facts[0].scoped, true);
  assert.match(facts[0].meta, /restricted folder/);

  const scopedNote = await T.memBuildDetail(notes.find((r) => r.numericId === 2));
  assert.equal(scopedNote.scoped, true);
  const html = buttons(scopedNote);
  assert.match(html, /Kept for a restricted folder; manage it from that folder/);
  assert.doesNotMatch(html, /memory:edit|memory:delete/);

  const openNote = await T.memBuildDetail(notes.find((r) => r.numericId === 1));
  assert.equal(openNote.scoped, false);
  assert.match(buttons(openNote), /data-act="memory:edit"/);
  assert.match(buttons(openNote), /data-act="memory:delete"/);

  const fact = await T.memBuildDetail(facts[0]);
  assert.equal(fact.scoped, true);
  assert.doesNotMatch(buttons(fact), /memory:edit|memory:delete/);
});

test('search (notes.recall, the m. alias) marks scoped rows and still answers on a database from before scopes', async () => {
  const add = (dir) => {
    const db = new DatabaseSync(join(dir, 'memory.sqlite'));
    db.exec(`CREATE VIRTUAL TABLE memories_fts USING fts5(content, content='memories', content_rowid='id')`);
    db.exec(`INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')`);
    db.close();
  };
  const scoped = stateDir({ withScope: true });
  add(scoped);
  const hits = await memoryQuery(scoped, 'notes.recall', ['"note"*', 10]);
  assert.equal(hits.ok, true, hits.error);
  assert.deepEqual(hits.rows.map((r) => [r.id, E.memScopedRow(r)]).sort(), [[1, false], [2, true]]);

  const old = stateDir({ withScope: false });
  add(old);
  const oldHits = await memoryQuery(old, 'notes.recall', ['"note"*', 10]);
  assert.equal(oldHits.ok, true, oldHits.error);
  assert.deepEqual(oldHits.rows.map((r) => [r.id, E.memScopedRow(r)]), [[1, false]]);
});
